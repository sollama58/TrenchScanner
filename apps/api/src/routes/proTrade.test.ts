// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadEnv,
  prisma,
  refreshProHolders,
  proHolderStanding,
  resetProHolderCacheForTests,
  type Env,
} from "@trenchscanner/core";
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
    await prisma.proModeSeen.deleteMany({ where: { walletAddress: { in: [ADMIN, TRADER] } } });
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
    await prisma.proModeSeen.deleteMany({ where: { walletAddress: { in: [ADMIN, TRADER] } } });
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

  it("quotes the network fee, with no platform fee, to Pro wallets only", async () => {
    const url = `/pro/trade/fee?mint=${MINT}&speed=eco&priorityFeeLamports=100000&tipLamports=20000`;
    expect((await as(TRADER, "GET", url)).statusCode).toBe(404);
    const fee = await as(ADMIN, "GET", url);
    expect(fee.statusCode).toBe(200);
    expect(fee.json()).toEqual({
      priorityFeeLamports: "100000",
      tipLamports: "20000",
      baseFeeLamports: "5000",
      platformFeeLamports: "0",
    });
    expect((await as(ADMIN, "GET", `/pro/trade/fee?mint=nope&speed=eco`)).statusCode).toBe(400);
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
    // Pro Mode gone, but it had it: it may still sell what it holds.
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({
      isPro: false,
      proMode: { canClose: true },
    });
  });

  it("is admins only while PRO_TRADING_PUBLIC is off: no grant, holder or sell-only access", async () => {
    const adminsOnly = await buildServer({ ...env, PRO_TRADING_PUBLIC: false });
    try {
      const me = (wallet: string) =>
        adminsOnly.inject({
          method: "GET",
          url: "/auth/me",
          cookies: { [SESSION_COOKIE_NAME]: cookies[wallet]! },
        });
      expect((await me(ADMIN)).json()).toMatchObject({ isPro: true });
      expect((await me(TRADER)).json()).toMatchObject({ isPro: false, proMode: { canClose: false } });
    } finally {
      await adminsOnly.close();
    }
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

/** A real wallet address (on the curve): the holder scan leaves program-owned ones out. */
const walletKey = () =>
  bs58.encode(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const HOLDER = walletKey();
const GRACE = walletKey();
const LAPSED = walletKey();
const NEWBIE = walletKey();

describe.skipIf(!dbAvailable)("Pro Mode for the top holders", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN } : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: string[] = [];
  const wallets = [HOLDER, GRACE, LAPSED, NEWBIE];
  const me = async (w: string) =>
    (
      await app.inject({ method: "GET", url: "/auth/me", cookies: { [SESSION_COOKIE_NAME]: cookies[w]! } })
    ).json() as {
      isPro: boolean;
      proMode: { source: string | null; canClose: boolean; rank?: number; graceEndsAt?: string };
    };
  const as = (w: string, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookies[w]! } });

  beforeAll(async () => {
    await prisma.proHolder.deleteMany({});
    await prisma.proModeSeen.deleteMany({ where: { walletAddress: { in: wallets } } });
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const wallet of wallets) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        update: {},
        create: { walletAddress: wallet },
      });
      ids.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    const now = Date.now();
    // Two scans: the holder in both, the grace wallet only in the older one (an hour ago), and
    // the lapsed wallet last in a day and more ago.
    await prisma.proHolder.createMany({
      data: [
        { walletAddress: LAPSED, rank: 250, lastInTopAt: new Date(now - 25 * 3_600_000) },
        // Held for hours until an hour ago.
        {
          walletAddress: GRACE,
          rank: 249,
          lastInTopAt: new Date(now - 3_600_000),
          inTopSince: new Date(now - 5 * 3_600_000),
        },
        // In the previous scan (ten minutes ago) and every one for two hours before it.
        {
          walletAddress: HOLDER,
          rank: 2,
          lastInTopAt: new Date(now - 600_000),
          inTopSince: new Date(now - 2 * 3_600_000),
        },
      ],
    });
    await refreshProHolders(
      {
        getTopHoldersBatch: async (mints) =>
          new Map(
            mints.map((m) => [m, { status: "found", holders: [{ owner: HOLDER }, { owner: NEWBIE }] }]),
          ),
      },
      new Date(now),
    );
    resetProHolderCacheForTests();
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.proHolder.deleteMany({});
    await prisma.proModeSeen.deleteMany({ where: { walletAddress: { in: wallets } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("gives the newest scan's holders Pro Mode, and a 24-hour grace to one that dropped out", async () => {
    expect(await me(HOLDER)).toMatchObject({
      isPro: true,
      proMode: { source: "holder", rank: 1, canClose: true },
    });
    const grace = await me(GRACE);
    expect(grace).toMatchObject({ isPro: true, proMode: { source: "grace", rank: 249 } });
    const left = Date.parse(grace.proMode.graceEndsAt!) - Date.now();
    expect(left).toBeGreaterThan(22.9 * 3_600_000);
    expect(left).toBeLessThan(23.1 * 3_600_000);
  });

  it("waits an hour of scans before a new holder gets it, so one bag can't hop between wallets", async () => {
    expect(await me(NEWBIE)).toMatchObject({ isPro: false, proMode: { source: null, canClose: false } });
    // The holder's run carried through the new scan: it keeps Pro Mode.
    const row = await prisma.proHolder.findUnique({ where: { walletAddress: HOLDER } });
    expect(Date.now() - row!.inTopSince.getTime()).toBeGreaterThan(1.9 * 3_600_000);
  });

  it("turns stopped scans into a grace period instead of Pro Mode with no end", async () => {
    const later = new Date(Date.now() + 2 * 3_600_000);
    const standing = await proHolderStanding(HOLDER, later);
    expect(standing).toMatchObject({ state: "grace", stale: true });
    // A day from the last scan it was in.
    expect((standing as { graceEndsAt: Date }).graceEndsAt.getTime() - Date.now()).toBeGreaterThan(
      23.9 * 3_600_000,
    );
  });

  it("lets a wallet that had Pro Mode sell, but not buy, after it ends", async () => {
    // Never seen with Pro Mode: nothing at all.
    expect(await me(LAPSED)).toMatchObject({ isPro: false, proMode: { canClose: false } });
    expect((await as(LAPSED, "GET", `/pro/trade/${MINT}/position`)).statusCode).toBe(404);
    // Seen with it once (any wallet that had it is recorded): selling stays open.
    await prisma.proModeSeen.create({ data: { walletAddress: LAPSED, lastProAt: new Date() } });
    expect(await me(LAPSED)).toMatchObject({ isPro: false, proMode: { canClose: true } });
    const buy = await as(LAPSED, "POST", "/pro/trade/build", {
      mint: MINT,
      side: "buy",
      amount: "1000",
      slippageBps: 100,
      speed: "eco",
    });
    expect(buy.statusCode).toBe(403);
    // A sale gets past the gate (this one then fails validation: no amount).
    expect((await as(LAPSED, "POST", "/pro/trade/build", { mint: MINT, side: "sell" })).statusCode).toBe(400);
    // And the grace wallet was recorded when it had Pro Mode, so it can close later too.
    expect(await prisma.proModeSeen.findUnique({ where: { walletAddress: GRACE } })).not.toBeNull();
  });

  it("changes no one's standing when a scan fails", async () => {
    await expect(refreshProHolders({ getTopHoldersBatch: async () => new Map() })).rejects.toThrow();
    resetProHolderCacheForTests();
    expect(await me(HOLDER)).toMatchObject({ isPro: true, proMode: { source: "holder" } });
  });
});
