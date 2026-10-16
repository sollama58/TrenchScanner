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
  let capped: FastifyInstance;
  const ids = { admin: "", user: "" };
  const cookies = { admin: "", user: "" };

  beforeAll(async () => {
    ids.admin = (await prisma.user.create({ data: { walletAddress: adminWallet } })).id;
    ids.user = (await prisma.user.create({ data: { walletAddress: userWallet } })).id;
    cookies.admin = await signer.sign({ userId: ids.admin, walletAddress: adminWallet, sessionVersion: 0 });
    cookies.user = await signer.sign({ userId: ids.user, walletAddress: userWallet, sessionVersion: 0 });
    app = await buildServer(env);
    off = await buildServer({ ...env, TRADING_BOT_ENABLED: false });
    capped = await buildServer({ ...env, TRADING_MAX_SLIPPAGE_BPS: 2500 });
  });
  afterAll(async () => {
    await app?.close();
    await off?.close();
    await capped?.close();
    if (!dbAvailable) return;
    const userIds = [ids.admin, ids.user].filter(Boolean);
    await prisma.paperStrategy.deleteMany({ where: { userId: { in: userIds } } });
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
    for (const [method, url] of [
      ["POST", "/trading/wallet"],
      ["PUT", "/trading/bot"],
      ["POST", "/trading/withdraw"],
      ["POST", "/trading/sell-all"],
      ["GET", "/trading/server"],
      ["PUT", "/trading/server/bot"],
      ["POST", "/trading/server/withdraw"],
    ] as const) {
      expect((await off.inject({ method, url, payload: {}, ...as("admin") })).statusCode).toBe(404);
    }
  });

  it("answers status while off: admins only, read-only, no secrets", async () => {
    expect((await off.inject({ method: "GET", url: "/trading/status" })).statusCode).toBe(401);
    expect((await off.inject({ method: "GET", url: "/trading/status", ...as("user") })).statusCode).toBe(403);
    const res = await off.inject({ method: "GET", url: "/trading/status", ...as("admin") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    // No ceilings unless the server sets them.
    expect(body.limits.maxBuySol).toBeNull();
    expect(body.defaults.sources).toMatchObject({ filterIds: [], models: [], requireAiBuy: true });
    expect(body.checks.find((c: { id: string }) => c.id === "server-wallet").ok).toBe(true);
    expect(res.body).not.toContain(env.TRADING_LOCAL_MASTER_KEY);
    const backtest = await off.inject({ method: "GET", url: "/trading/backtest?days=3", ...as("admin") });
    expect(backtest.statusCode).toBe(200);
    expect(backtest.json()).toMatchObject({ days: 3, models: expect.any(Array) });
    expect((await off.inject({ method: "GET", url: "/trading/backtest", ...as("user") })).statusCode).toBe(
      403,
    );
    // The same route reports the bot on where it is.
    expect((await app.inject({ method: "GET", url: "/trading/status", ...as("admin") })).json().enabled).toBe(
      true,
    );
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

  it("has no ceilings by default, enforces one the server sets, and refuses paired-phone sessions", async () => {
    const big = await app.inject({
      method: "PUT",
      url: "/trading/bot",
      ...as("admin"),
      payload: { config: { slippageBps: 4000, buySol: 50, maxDailySpendSol: 500, maxOpenPositions: 200 } },
    });
    expect(big.statusCode).toBe(200);
    const over = await capped.inject({
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
    // Nor may it withdraw the owner's own wallet.
    const out = await app.inject({
      method: "POST",
      url: "/trading/withdraw",
      cookies: { [SESSION_COOKIE_NAME]: phone },
      payload: { amount: "max" },
    });
    expect(out.statusCode).toBe(403);
    expect(out.json().error).toMatch(/sign in with your wallet/);
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

  it("runs paper trading while the bot is off: admins only, at most three running at once", async () => {
    const url = "/trading/paper";
    expect((await off.inject({ method: "GET", url, ...as("user") })).statusCode).toBe(403);
    expect((await off.inject({ method: "POST", url, payload: {}, ...as("user") })).statusCode).toBe(403);
    const created: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await off.inject({
        method: "POST",
        url,
        payload: { name: `S${i}`, bankrollSol: 5, config: { sources: { models: ["rules", "nope"] } } },
        ...as("admin"),
      });
      expect(res.statusCode).toBe(200);
      created.push(res.json().id);
    }
    for (const id of created.slice(0, 3)) {
      const res = await off.inject({
        method: "PATCH",
        url: `${url}/${id}`,
        payload: { running: true },
        ...as("admin"),
      });
      expect(res.statusCode).toBe(200);
    }
    const fourth = await off.inject({
      method: "PATCH",
      url: `${url}/${created[3]}`,
      payload: { running: true },
      ...as("admin"),
    });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toMatch(/at most 3/);
    // Stopping one frees a slot.
    await off.inject({
      method: "PATCH",
      url: `${url}/${created[0]}`,
      payload: { running: false },
      ...as("admin"),
    });
    expect(
      (
        await off.inject({
          method: "PATCH",
          url: `${url}/${created[3]}`,
          payload: { running: true },
          ...as("admin"),
        })
      ).statusCode,
    ).toBe(200);

    const list = (await off.inject({ method: "GET", url, ...as("admin") })).json();
    expect(list.maxRunning).toBe(3);
    expect(list.strategies).toHaveLength(4);
    const first = list.strategies[0];
    expect(first.bankrollLamports).toBe("5000000000");
    expect(first.cashLamports).toBe("5000000000");
    // Unknown models are dropped.
    expect(first.config.sources.models).toEqual(["rules"]);
    expect(first.stats.entries).toBe(0);

    // No caps on the settings beyond what keeps them meaningful.
    const big = await off.inject({
      method: "PATCH",
      url: `${url}/${created[1]}`,
      payload: {
        config: { buySol: 500, maxDailySpendSol: 10_000, maxOpenPositions: 1000, fillPenaltyBps: 250 },
      },
      ...as("admin"),
    });
    expect(big.statusCode).toBe(200);
    expect(big.json().config).toMatchObject({ buySol: 500, fillPenaltyBps: 250 });

    // Another admin's strategy is not yours; a reset refills the bankroll; delete removes it.
    expect(
      (
        await off.inject({
          method: "POST",
          url: `${url}/${created[1]}/reset`,
          payload: { bankrollSol: 2 },
          ...as("admin"),
        })
      ).statusCode,
    ).toBe(200);
    const reset = await prisma.paperStrategy.findUniqueOrThrow({ where: { id: created[1]! } });
    expect(reset.cashLamports).toBe(2_000_000_000n);
    expect(
      (await off.inject({ method: "DELETE", url: `${url}/${created[1]}`, ...as("admin") })).statusCode,
    ).toBe(200);
    expect(
      (await off.inject({ method: "DELETE", url: `${url}/${created[1]}`, ...as("admin") })).statusCode,
    ).toBe(404);
    await prisma.paperStrategy.deleteMany({ where: { userId: ids.admin } });
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
