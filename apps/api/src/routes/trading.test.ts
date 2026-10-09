// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, loadEnv, generateWalletKeypair } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("trading routes", () => {
  const base = loadEnv();
  const signer = createSessionSigner(base.JWT_SECRET, base.SESSION_TTL_HOURS);
  // Real-looking keys: a withdrawal's destination is the sign-in wallet.
  const adminWallet = generateWalletKeypair().publicKey;
  const userWallet = generateWalletKeypair().publicKey;
  const serverWallet = generateWalletKeypair().publicKey;
  const serverDestination = generateWalletKeypair().publicKey;
  const env = {
    ...base,
    TRADING_BOT_ENABLED: true,
    TRADING_KEY_PROVIDER: "local" as const,
    TRADING_LOCAL_MASTER_KEY: "cd".repeat(32),
    ADMIN_WALLET_ADDRESSES: adminWallet,
    // Refused at once: the balance read fails fast instead of reaching for a real RPC.
    SOLANA_RPC_URL: "http://127.0.0.1:9",
    // The server wallet: only its public half and the withdrawal address reach the api.
    TRADING_SERVER_WALLET_ADDRESS: serverWallet,
    TRADING_SERVER_WALLET_WITHDRAW_TO: serverDestination,
  };
  let app: FastifyInstance;
  let off: FastifyInstance;
  const ids = { admin: "", user: "" };
  const cookies = { admin: "", user: "" };

  beforeAll(async () => {
    ids.admin = (await prisma.user.create({ data: { walletAddress: adminWallet } })).id;
    ids.user = (await prisma.user.create({ data: { walletAddress: userWallet } })).id;
    cookies.admin = await signer.sign({ userId: ids.admin, walletAddress: adminWallet, sessionVersion: 0 });
    cookies.user = await signer.sign({ userId: ids.user, walletAddress: userWallet, sessionVersion: 0 });
    app = await buildServer(env);
    off = await buildServer({ ...env, TRADING_BOT_ENABLED: false });
  });
  afterAll(async () => {
    await app?.close();
    await off?.close();
    if (!dbAvailable) return;
    const userIds = [ids.admin, ids.user].filter(Boolean);
    await prisma.tradingWithdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tradingPosition.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tradingBot.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tradingWallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userFilter.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const as = (who: keyof typeof cookies) => ({ cookies: { [SESSION_COOKIE_NAME]: cookies[who] } });

  it("does not exist while the feature is off", async () => {
    expect((await off.inject({ method: "GET", url: "/trading", ...as("admin") })).statusCode).toBe(404);
  });

  it("needs a session, and an admin to start", async () => {
    expect((await app.inject({ method: "GET", url: "/trading" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/trading", ...as("user") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/trading/wallet", ...as("user") })).statusCode).toBe(
      403,
    );
    expect(
      (await app.inject({ method: "PUT", url: "/trading/bot", payload: {}, ...as("user") })).statusCode,
    ).toBe(403);
  });

  it("creates one sealed wallet per admin and shows the default exit plan", async () => {
    const first = await app.inject({ method: "POST", url: "/trading/wallet", ...as("admin") });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/trading/wallet", ...as("admin") });
    expect(again.json().publicKey).toBe(first.json().publicKey);
    const row = await prisma.tradingWallet.findUniqueOrThrow({ where: { userId: ids.admin } });
    expect(row.keyProvider).toBe("local");
    expect(row.secretCiphertext.length).toBe(32);

    const state = await app.inject({ method: "GET", url: "/trading", ...as("admin") });
    expect(state.statusCode).toBe(200);
    const body = state.json();
    expect(body.canTrade).toBe(true);
    expect(body.wallet.publicKey).toBe(first.json().publicKey);
    expect(body.withdrawTo).toBe(adminWallet);
    // The withdrawal address is sealed into the new wallet's key.
    expect(row.withdrawTo).toBe(adminWallet);
    expect(body.bot.config.exitPlan).toBeNull();
    expect(body.defaults.exitPlanSummary).toMatch(/sell half at 2x/);
    // Never anything that could open the wallet.
    expect(JSON.stringify(body)).not.toMatch(/secret|wrapped/i);
  });

  it("saves settings, keeping only the user's own filters and known models", async () => {
    const mine = await prisma.userFilter.create({ data: { userId: ids.admin, name: "mine" } });
    const theirs = await prisma.userFilter.create({ data: { userId: ids.user, name: "theirs" } });
    const res = await app.inject({
      method: "PUT",
      url: "/trading/bot",
      ...as("admin"),
      payload: {
        enabled: true,
        config: { sources: { filterIds: [mine.id, theirs.id], models: ["rules", "nope"] }, buySol: 0.1 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.sources).toMatchObject({ filterIds: [mine.id], models: ["rules"] });
    const bot = await prisma.tradingBot.findUniqueOrThrow({ where: { userId: ids.admin } });
    expect(bot.enabled).toBe(true);
    expect(Date.now() - bot.signalsFrom.getTime()).toBeLessThan(10_000);

    const bad = await app.inject({
      method: "PUT",
      url: "/trading/bot",
      ...as("admin"),
      payload: {
        config: {
          exitPlan: {
            takeProfits: [
              { multiple: 2, sellFraction: 0.8 },
              { multiple: 3, sellFraction: 0.8 },
            ],
            stopFraction: 0.5,
            maxHoldMinutes: 30,
            trail: [],
            trailMaxHoldMinutes: 60,
          },
        },
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("enforces the server's ceilings and refuses paired-phone sessions for bot changes", async () => {
    const over = await app.inject({
      method: "PUT",
      url: "/trading/bot",
      ...as("admin"),
      payload: { config: { slippageBps: 4000 } },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatch(/slippageBps/);
    const device = await prisma.linkedDevice.create({ data: { userId: ids.admin } });
    const phone = await signer.sign({ userId: ids.admin, walletAddress: adminWallet, deviceId: device.id });
    const res = await app.inject({
      method: "PUT",
      url: "/trading/bot",
      cookies: { [SESSION_COOKIE_NAME]: phone },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/sign in with your wallet/);
    // Viewing still works from the phone.
    const view = await app.inject({
      method: "GET",
      url: "/trading",
      cookies: { [SESSION_COOKIE_NAME]: phone },
    });
    expect(view.statusCode).toBe(200);
    await prisma.linkedDevice.delete({ where: { id: device.id } });
  });

  it("withdraws only to the sign-in wallet, one at a time", async () => {
    const tooSmall = await app.inject({
      method: "POST",
      url: "/trading/withdraw",
      ...as("admin"),
      payload: { amount: "1" },
    });
    expect(tooSmall.statusCode).toBe(400);
    // A destination in the body is ignored: there is no such field.
    const ok = await app.inject({
      method: "POST",
      url: "/trading/withdraw",
      ...as("admin"),
      payload: { amount: "max", destination: userWallet },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().destination).toBe(adminWallet);
    const second = await app.inject({
      method: "POST",
      url: "/trading/withdraw",
      ...as("admin"),
      payload: { amount: "max" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("lets the owner of a wallet withdraw and sell, without being an admin", async () => {
    await prisma.tradingWallet.create({
      data: {
        userId: ids.user,
        publicKey: generateWalletKeypair().publicKey,
        secretCiphertext: Buffer.alloc(32),
        secretIv: Buffer.alloc(12),
        secretAuthTag: Buffer.alloc(16),
        wrappedDataKey: Buffer.alloc(60),
        keyProvider: "local",
        keyRef: "local:test",
        withdrawTo: userWallet,
      },
    });
    const state = await app.inject({ method: "GET", url: "/trading", ...as("user") });
    expect(state.statusCode).toBe(200);
    expect(state.json().canTrade).toBe(false);
    expect((await app.inject({ method: "POST", url: "/trading/sell-all", ...as("user") })).statusCode).toBe(
      200,
    );
    const w = await app.inject({
      method: "POST",
      url: "/trading/withdraw",
      ...as("user"),
      payload: { amount: "max" },
    });
    expect(w.json().destination).toBe(userWallet);
    expect(
      (await app.inject({ method: "PUT", url: "/trading/bot", payload: {}, ...as("user") })).statusCode,
    ).toBe(403);
  });

  describe("the server wallet", () => {
    let noWithdraw: FastifyInstance;
    let serverAccount = "";
    beforeAll(async () => {
      noWithdraw = await buildServer({ ...env, TRADING_SERVER_WALLET_WITHDRAW_TO: "" });
    });
    afterAll(async () => {
      await noWithdraw?.close();
      if (!serverAccount) return;
      await prisma.tradingWithdrawal.deleteMany({ where: { userId: serverAccount } });
      await prisma.tradingBot.deleteMany({ where: { userId: serverAccount } });
    });

    it("is for admins only, and shows its address but never a key", async () => {
      expect((await app.inject({ method: "GET", url: "/trading/server", ...as("user") })).statusCode).toBe(
        403,
      );
      expect(
        (await app.inject({ method: "PUT", url: "/trading/server/bot", payload: {}, ...as("user") }))
          .statusCode,
      ).toBe(403);
      const own = await app.inject({ method: "GET", url: "/trading", ...as("admin") });
      expect(own.json().serverWallet).toEqual({ configured: true });
      const res = await app.inject({ method: "GET", url: "/trading/server", ...as("admin") });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.scope).toBe("server");
      expect(body.wallet.publicKey).toBe(serverWallet);
      expect(body.withdrawTo).toBe(serverDestination);
      expect(JSON.stringify(body)).not.toMatch(/secret/i);
      serverAccount = (await prisma.user.findUniqueOrThrow({ where: { walletAddress: "server-wallet" } })).id;
    });

    it("follows admins' filters and models, set by any admin", async () => {
      const adminFilter = await prisma.userFilter.create({ data: { userId: ids.admin, name: "admin's" } });
      const userFilter = await prisma.userFilter.create({ data: { userId: ids.user, name: "user's" } });
      const res = await app.inject({
        method: "PUT",
        url: "/trading/server/bot",
        ...as("admin"),
        payload: {
          enabled: true,
          config: { sources: { filterIds: [adminFilter.id, userFilter.id], models: ["rules"] }, buySol: 0.1 },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().config.sources).toMatchObject({ filterIds: [adminFilter.id], models: ["rules"] });
      const bot = await prisma.tradingBot.findUniqueOrThrow({ where: { userId: serverAccount } });
      expect(bot.enabled).toBe(true);
      // The admin's own bot is untouched by it.
      const own = await prisma.tradingBot.findUnique({ where: { userId: ids.admin } });
      expect(own?.config).not.toEqual(bot.config);
    });

    it("withdraws only to the configured address, and not without one", async () => {
      const off = await noWithdraw.inject({
        method: "POST",
        url: "/trading/server/withdraw",
        ...as("admin"),
        payload: { amount: "max" },
      });
      expect(off.statusCode).toBe(409);
      expect(off.json().error).toMatch(/TRADING_SERVER_WALLET_WITHDRAW_TO/);
      const ok = await app.inject({
        method: "POST",
        url: "/trading/server/withdraw",
        ...as("admin"),
        payload: { amount: "max", destination: adminWallet },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().destination).toBe(serverDestination);
    });
  });
});
