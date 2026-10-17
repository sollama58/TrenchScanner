// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { plainRefusal } from "./proTrade.js";

describe("plainRefusal", () => {
  it("says the common refusals in the trader's words", () => {
    expect(plainRefusal('refused: simulation failed: {"InstructionError":[3,{"Custom":1}]}')).toMatch(
      /Not enough SOL/,
    );
    expect(plainRefusal("refused: simulation failed: custom program error: 0x1771")).toMatch(/slippage/);
    expect(plainRefusal("refused: simulation failed: AccountNotFound")).toMatch(/no SOL yet/);
    expect(plainRefusal("refused: a program this swap may not call")).toBe(
      "The trade was refused before signing: a program this swap may not call",
    );
  });
});

const ADMIN = "ProModeAdmin1111111111111111111111111111111";
const TRADER = "ProModeTrader111111111111111111111111111111";
const MINT = "So11111111111111111111111111111111111111112";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("Pro Mode", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN } : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: string[] = [];

  const as = (who: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookies[who]! } });

  beforeAll(async () => {
    resetContestStateCache();
    await prisma.proModeGrant.deleteMany({ where: { walletAddress: { in: [ADMIN, TRADER] } } });
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const wallet of [ADMIN, TRADER]) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        update: {},
        create: { walletAddress: wallet },
      });
      ids.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.proModeGrant.deleteMany({ where: { walletAddress: { in: [ADMIN, TRADER] } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("is on for admins and off for everyone else until granted", async () => {
    expect((await as(ADMIN, "GET", "/auth/me")).json()).toMatchObject({ walletAddress: ADMIN, isPro: true });
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({
      walletAddress: TRADER,
      isPro: false,
    });
  });

  it("hides every trade route from a wallet without it", async () => {
    expect((await as(TRADER, "GET", `/pro/trade/${MINT}/position`)).statusCode).toBe(404);
    expect(
      (
        await as(TRADER, "POST", "/pro/trade/build", {
          mint: MINT,
          side: "buy",
          amount: "1000",
          slippageBps: 100,
          speed: "eco",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await as(TRADER, "POST", "/pro/trade/send", { transaction: "AA==", lastValidBlockHeight: 1 }))
        .statusCode,
    ).toBe(404);
    // Signed out: no session at all.
    expect((await app.inject({ method: "GET", url: `/pro/trade/${MINT}/position` })).statusCode).toBe(401);
  });

  it("lets only admins grant it, and a grant turns it on", async () => {
    expect((await as(TRADER, "POST", "/admin/pro-mode", { walletAddress: TRADER })).statusCode).toBe(403);
    expect((await as(ADMIN, "POST", "/admin/pro-mode", { walletAddress: "nope" })).statusCode).toBe(400);
    const granted = await as(ADMIN, "POST", "/admin/pro-mode", { walletAddress: TRADER, note: "tester" });
    expect(granted.statusCode).toBe(200);
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({ isPro: true });
    const list = (await as(ADMIN, "GET", "/admin/pro-mode")).json() as {
      admins: string[];
      grants: { walletAddress: string; note: string; signedUp: boolean }[];
    };
    expect(list.admins).toContain(ADMIN);
    expect(list.grants.find((g) => g.walletAddress === TRADER)).toMatchObject({
      note: "tester",
      signedUp: true,
    });
    // A bad request from a Pro wallet now reaches the route itself.
    expect((await as(TRADER, "POST", "/pro/trade/build", { mint: MINT, side: "buy" })).statusCode).toBe(400);
    // A send that isn't a signed transaction from the session's wallet is refused before Sender.
    expect(
      (await as(TRADER, "POST", "/pro/trade/send", { transaction: "AA==", lastValidBlockHeight: 1 }))
        .statusCode,
    ).toBe(400);

    expect((await as(ADMIN, "DELETE", `/admin/pro-mode/${TRADER}`)).statusCode).toBe(200);
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({ isPro: false });
  });

  it("is off for everyone, admins included, when switched off", async () => {
    const off = await buildServer({ ...env, PRO_TRADING_ENABLED: false });
    try {
      const me = await off.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { [SESSION_COOKIE_NAME]: cookies[ADMIN]! },
      });
      expect(me.json()).toMatchObject({ isPro: false });
    } finally {
      await off.close();
    }
  });
});
