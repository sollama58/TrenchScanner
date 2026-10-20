// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadEnv,
  pingSender,
  prisma,
  refreshProHolders,
  proHolderRank,
  proHolderSummary,
  refreshProHoldersOnDemand,
  proHolderStanding,
  resetProHolderCacheForTests,
  SUBSCRIPTION_MINT,
  type Env,
} from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import {
  freeAsdfBuy,
  chainTradeState,
  landedFailure,
  plainRefusal,
  quietSign,
  resendTarget,
  sellShare,
  slippageMiss,
  SLIPPAGE_LANDED,
  SLIPPAGE_UNSENT,
  RENT_SHORT,
  TRADE_COOLDOWN_MS,
  TradeCooldown,
} from "./proTrade.js";

// The fee route pings Sender in the background: answered here, so no test reaches the network.
vi.mock("@trenchscanner/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trenchscanner/core")>()),
  pingSender: vi.fn(async () => true),
}));

describe("plainRefusal", () => {
  it("says the common refusals in the trader's words", () => {
    expect(plainRefusal('refused: simulation failed: {"InstructionError":[3,{"Custom":1}]}')).toMatch(
      /Not enough SOL/,
    );
    expect(plainRefusal("refused: simulation failed: custom program error: 0x1771")).toBe(SLIPPAGE_UNSENT);
    // The RPC's err object, not the log line: Jupiter's SlippageToleranceExceeded is Custom 6001.
    expect(plainRefusal('refused: simulation failed: {"InstructionError":[2,{"Custom":6001}]}')).toBe(
      SLIPPAGE_UNSENT,
    );
    expect(plainRefusal('{"InstructionError":[4,{"Custom":6002}]}')).toMatch(/Nothing was sent/);
    expect(plainRefusal('{"InstructionError":[4,{"Custom":6042}]}')).toMatch(/slippage/);
    expect(plainRefusal("refused: simulation failed: AccountNotFound")).toMatch(/no SOL yet/);
    expect(plainRefusal("refused: a program this swap may not call")).toBe(
      "The trade was refused before signing: a program this swap may not call",
    );
    expect(plainRefusal("refused: simulation failed: InsufficientFundsForRent")).toBe(RENT_SHORT);
    expect(plainRefusal('{"InstructionError":[3,{"Custom":1}]}', "sell")).toMatch(/fewer tokens/);
    expect(plainRefusal("simulation failed: InstructionError unknown")).toMatch(/wasn't signed/);
    expect(plainRefusal("blockhash expired")).toMatch(/refused before signing/);
  });
});

describe("landedFailure", () => {
  it("says a landed slippage miss is not a fill, and leaves a timeout alone", () => {
    const slipped = landedFailure('{"InstructionError":[2,{"Custom":6001}]}');
    expect(slipped).toEqual({ reason: "slippage", error: SLIPPAGE_LANDED });
    expect(slipped.error).not.toMatch(/Nothing was sent/);
    expect(landedFailure("custom program error: 0x1771").reason).toBe("slippage");
    expect(landedFailure("custom program error: 0x179a").reason).toBe("slippage");
    // Not enough SOL is its own cause, and it did land.
    expect(landedFailure('{"InstructionError":[3,{"Custom":1}]}')).toEqual({
      reason: "rejected",
      error: "Not enough SOL in your wallet for this trade and its fees. Nothing was bought or sold.",
    });
    // A drop or a timeout is not rewritten into a slippage miss, and the chain's words stay.
    const dropped = landedFailure("timed out");
    expect(dropped.reason).toBe("rejected");
    expect(dropped.error).toBe("timed out");
    expect(slippageMiss("timed out")).toBe(false);
    expect(slippageMiss("blockhash not found")).toBe(false);
    expect(slippageMiss('{"Custom":16001}')).toBe(false);
    expect(landedFailure("InsufficientFundsForRent").error).toMatch(/rent-exempt/);
    expect(landedFailure("InsufficientFundsForRent").error).toMatch(/Nothing was bought or sold/);
    expect(landedFailure('{"InstructionError":[2,{"Custom":1}]}', "sell").error).toMatch(/fewer tokens/);
    expect(landedFailure("simulation failed: something else").error).toMatch(/program rejected it/);
    expect(landedFailure("processed").error).toBe("processed");
  });
});

describe("resendTarget", () => {
  const row = {
    status: "sent",
    wallet: "w",
    transaction: "bytes",
    lastValidBlockHeight: 100n,
  };
  it("reattaches the same bytes while the blockhash is still live", () => {
    expect(resendTarget(row, "w", 90)).toEqual({ base64: "bytes", lastValidBlockHeight: 100 });
    expect(resendTarget(row, "w", null)).toEqual({ base64: "bytes", lastValidBlockHeight: 100 });
    expect(resendTarget(row, "w", 101)).toBeNull();
    expect(resendTarget({ ...row, status: "confirmed" }, "w", 90)).toBeNull();
    expect(resendTarget({ ...row, transaction: null }, "w", 90)).toBeNull();
    expect(resendTarget(row, "other", 90)).toBeNull();
    expect(resendTarget(null, "w", 90)).toBeNull();
  });
});

describe("chainTradeState", () => {
  it("treats processed as a success so far, not a failure", () => {
    expect(chainTradeState({ seen: true, confirmed: false, error: null })).toBe("processed");
    expect(chainTradeState({ seen: true, confirmed: true, error: null })).toBe("confirmed");
    expect(chainTradeState({ seen: true, confirmed: false, error: "x" })).toBe("failed");
    expect(chainTradeState({ seen: false, confirmed: false, error: null })).toBe("unseen");
  });
});

describe("sellShare", () => {
  it("takes a percent of the balance read at build time, and all of it at 100", () => {
    expect(sellShare(1_000n, 25)).toBe(250n);
    expect(sellShare(999n, 50)).toBe(499n);
    expect(sellShare(123_456_789_012_345_678n, 100)).toBe(123_456_789_012_345_678n);
    expect(sellShare(10n, 1)).toBe(0n);
  });
});

describe("freeAsdfBuy", () => {
  it("frees every wallet's $ASDFASDFA buy from the Sacrifice, and nothing else", () => {
    expect(freeAsdfBuy("buy", SUBSCRIPTION_MINT)).toBe(true);
    expect(freeAsdfBuy("sell", SUBSCRIPTION_MINT)).toBe(false);
    expect(freeAsdfBuy("buy", "So11111111111111111111111111111111111111112")).toBe(false);
  });
});

describe("TradeCooldown", () => {
  it("spaces one wallet's trades by its window, and gives a refused send's slot back", () => {
    expect(TRADE_COOLDOWN_MS).toBe(1_000);
    let now = 1_000_000;
    const cooldown = new TradeCooldown(5_000, () => now);
    expect(cooldown.left("a")).toBe(0);
    cooldown.take("a");
    now += 2_000;
    expect(cooldown.left("a")).toBe(3_000);
    // Another wallet isn't held up.
    expect(cooldown.left("b")).toBe(0);
    now += 3_000;
    expect(cooldown.left("a")).toBe(0);
    // Sender refused it: nothing went out, so the earlier send's window stands again.
    const giveBack = cooldown.take("a");
    giveBack();
    expect(cooldown.left("a")).toBe(0);
    const fresh = new TradeCooldown(5_000, () => now);
    fresh.take("c")();
    expect(fresh.left("c")).toBe(0);
  });
});

const ADMIN = "ProModeAdmin1111111111111111111111111111111";
const walletKey = () =>
  bs58.encode(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32));
// A real key: grants take only addresses on the curve.
const TRADER = walletKey();
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
    // Send stays reachable for the in-app $ASDFASDFA buy (anyone signed in, while trading is on),
    // but relays only what a build made for this wallet: this is refused, unsent.
    const send = await as(TRADER, "POST", "/pro/trade/send", {
      transaction: "AA==",
      lastValidBlockHeight: 1,
    });
    expect(send.statusCode).toBe(env.PRO_TRADING_ENABLED ? 400 : 404);
    expect(send.json()).toMatchObject({ notSent: true });
    // Signed out: no session at all.
    expect((await app.inject({ method: "GET", url: `/pro/trade/${MINT}/position` })).statusCode).toBe(401);
    // The credit picks follow the access buy: open to anyone signed in while trading is on.
    expect((await app.inject({ method: "GET", url: "/pro/trade/credit-picks" })).statusCode).toBe(401);
    if (!env.PRO_TRADING_ENABLED)
      expect((await as(TRADER, "GET", "/pro/trade/credit-picks")).statusCode).toBe(404);
  });

  it("quotes the network fee, with no platform fee while the Sacrifice is off, to Pro wallets only", async () => {
    const url = `/pro/trade/fee?mint=${MINT}&speed=eco&priorityFeeLamports=100000&tipLamports=20000`;
    expect((await as(TRADER, "GET", url)).statusCode).toBe(404);
    const fee = await as(ADMIN, "GET", url);
    expect(fee.statusCode).toBe(200);
    expect(fee.json()).toEqual({
      priorityFeeLamports: "100000",
      tipLamports: "20000",
      baseFeeLamports: "5000",
      platformFeeLamports: "0",
      sacrifice: expect.objectContaining({ mode: "off", pays: false, credits: null }),
      // Sender's health (senderHealth.test.ts): the background ping is mocked to answer.
      senderDown: false,
    });
    expect(vi.mocked(pingSender)).toHaveBeenCalledTimes(1);
    expect((await as(ADMIN, "GET", `/pro/trade/fee?mint=nope&speed=eco`)).statusCode).toBe(400);
    // Swap costs: Pro wallets only too, and a bad mint is refused before any quote.
    expect((await as(TRADER, "GET", `/pro/trade/costs?mint=${MINT}`)).statusCode).toBe(404);
    expect((await as(ADMIN, "GET", `/pro/trade/costs?mint=nope`)).statusCode).toBe(400);
    // A sale's quote: the same gate, and an amount is needed.
    expect((await as(TRADER, "GET", `/pro/trade/sale-quote?mint=${MINT}&units=5`)).statusCode).toBe(404);
    expect((await as(ADMIN, "GET", `/pro/trade/sale-quote?mint=${MINT}&units=0`)).statusCode).toBe(400);
    expect((await as(ADMIN, "GET", `/pro/trade/sale-quote?mint=nope&units=5`)).statusCode).toBe(400);
  });

  it("shows a Pro wallet the fees its confirmed trades here saved, and no one else", async () => {
    expect((await as(TRADER, "GET", "/pro/trade/fees")).statusCode).toBe(404);
    await prisma.platformTrade.deleteMany({ where: { wallet: ADMIN } });
    expect((await as(ADMIN, "GET", "/pro/trade/fees")).json()).toMatchObject({ trades: 0, since: null });
    const sig = (n: number) => `fees-test-${n}`;
    await prisma.platformTrade.createMany({
      data: [
        {
          signature: sig(1),
          wallet: ADMIN,
          mint: MINT,
          side: "buy",
          lamports: 2_000_000_000n,
          networkFeeLamports: 100_000n,
          status: "confirmed",
        },
        {
          signature: sig(2),
          wallet: ADMIN,
          mint: MINT,
          side: "sell",
          lamports: 4_000_000_000n,
          networkFeeLamports: 100_000n,
          status: "confirmed",
        },
        // Not landed: never counted.
        {
          signature: sig(3),
          wallet: ADMIN,
          mint: MINT,
          side: "buy",
          lamports: 9_000_000_000n,
          networkFeeLamports: 100_000n,
          status: "expired",
        },
      ],
    });
    try {
      const body = (await as(ADMIN, "GET", "/pro/trade/fees")).json();
      expect(body).toMatchObject({ trades: 2, volumeSol: 6, platformFeeSol: 0, networkFeeSol: 0.0002 });
      expect(
        Object.fromEntries(body.platforms.map((p: { id: string; savedSol: number }) => [p.id, p.savedSol])),
      ).toEqual({
        fomo: 0.03,
        pumpfun: 0.027,
        terminal: 0.03,
        axiom: 0.057,
      });
    } finally {
      await prisma.platformTrade.deleteMany({ where: { wallet: ADMIN } });
    }
  });

  it("refuses a buy under 0.01 SOL before building anything", async () => {
    const res = await as(ADMIN, "POST", "/pro/trade/build", {
      mint: MINT,
      side: "buy",
      amount: "9999999",
      slippageBps: 100,
      speed: "eco",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "The smallest buy is 0.01 SOL." });
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

    // A grant with an end date in the past no longer counts, and a re-grant replaces it.
    await prisma.proModeGrant.update({
      where: { walletAddress: TRADER },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({ isPro: false });
    const regrant = await as(ADMIN, "POST", "/admin/pro-mode", { walletAddress: TRADER, days: 2 });
    expect(regrant.statusCode).toBe(200);
    const ends = Date.parse((regrant.json() as { expiresAt: string }).expiresAt) - Date.now();
    expect(ends).toBeGreaterThan(47.9 * 3_600_000);
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({ isPro: true });
    expect(
      // A program-derived address passes the old shape check but no one holds its key.
      (
        await as(ADMIN, "POST", "/admin/pro-mode", {
          walletAddress: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        })
      ).statusCode,
    ).toBe(400);

    expect((await as(ADMIN, "DELETE", `/admin/pro-mode/${TRADER}`)).statusCode).toBe(200);
    // Pro Mode gone: no trading at all, sells included.
    expect((await as(TRADER, "GET", "/auth/me")).json()).toMatchObject({
      isPro: false,
      proMode: { canClose: false },
    });
    expect((await as(TRADER, "POST", "/pro/trade/build", { mint: MINT, side: "sell" })).statusCode).toBe(404);
  });

  it("is admins only while PRO_TRADING_PUBLIC is off: no grant or holder access", async () => {
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
    // The first reader fails, so the backup's read is the scan.
    await refreshProHolders(
      [
        { getTopHoldersBatch: async (mints) => new Map(mints.map((m) => [m, { status: "failed" }])) },
        {
          getTopHoldersBatch: async (mints) =>
            new Map(
              mints.map((m) => [m, { status: "found", holders: [{ owner: HOLDER }, { owner: NEWBIE }] }]),
            ),
        },
      ],
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

  it("gives a new holder Pro Mode at the first scan that finds it (user decision: no wait)", async () => {
    expect(await me(NEWBIE)).toMatchObject({ isPro: true, proMode: { source: "holder", rank: 2 } });
    // The holder's run carried through the new scan: it keeps Pro Mode.
    const row = await prisma.proHolder.findUnique({ where: { walletAddress: HOLDER } });
    expect(Date.now() - row!.inTopSince.getTime()).toBeGreaterThan(1.9 * 3_600_000);
  });

  it("gives Settings each wallet's place in the newest scan, or none outside it", async () => {
    expect(await proHolderRank(HOLDER)).toMatchObject({ rank: 1, of: 250, stale: false, qualifiesAt: null });
    // New in this scan, with Pro Mode already: nothing left to wait for.
    expect(await proHolderRank(NEWBIE)).toMatchObject({ rank: 2, cutoffRaw: null, qualifiesAt: null });
    expect(await proHolderRank(GRACE)).toMatchObject({ rank: null });
    expect((await proHolderRank(LAPSED)).scannedAt).not.toBeNull();
  });

  it("lists the newest scan for Admin by rank, with who has Pro Mode", async () => {
    const summary = await proHolderSummary();
    expect(summary).toMatchObject({ inTop: 2, qualifying: 0, stale: false });
    expect(summary.top.map((h) => [h.walletAddress, h.qualifiesAt === null])).toEqual([
      [HOLDER, true],
      [NEWBIE, true],
    ]);
    expect(summary.grace.map((g) => g.walletAddress)).toEqual([GRACE]);
  });

  it("lets Check now rescan at most once a minute, site-wide and per wallet", async () => {
    let reads = 0;
    const reader = {
      getTopHoldersBatch: async (mints: string[]) => {
        reads += 1;
        return new Map(
          mints.map((m) => [m, { status: "found", holders: [{ owner: HOLDER }, { owner: NEWBIE }] }]),
        );
      },
    };
    // The newest scan is seconds old: it answers the press, no new read.
    expect(await refreshProHoldersOnDemand(reader)).toEqual({ scanned: false });
    expect(reads).toBe(0);
    const press = await as(NEWBIE, "POST", "/subscription/pro-check");
    expect(press.statusCode).toBe(200);
    expect(press.json()).toMatchObject({ scanned: false, nextCheckSec: 60 });
    const again = await as(NEWBIE, "POST", "/subscription/pro-check");
    expect(again.statusCode).toBe(429);
    expect(again.json().retryAfterSec).toBeGreaterThan(55);
  });

  it("keeps Pro Mode for the newest scan's wallets while the scans are stopped", async () => {
    // Hours, and then days, past the newest scan: an outage never ends it, sells included.
    for (const hours of [2, 30, 72]) {
      const later = new Date(Date.now() + hours * 3_600_000);
      expect(await proHolderStanding(HOLDER, later)).toMatchObject({ state: "top", rank: 1 });
    }
  });

  it("lets a wallet whose Pro Mode ended trade nothing, sells included", async () => {
    // Even one recorded with Pro Mode under the old sell-only rule.
    await prisma.proModeSeen.create({ data: { walletAddress: LAPSED, lastProAt: new Date() } });
    expect(await me(LAPSED)).toMatchObject({ isPro: false, proMode: { canClose: false } });
    expect((await as(LAPSED, "GET", `/pro/trade/${MINT}/position`)).statusCode).toBe(404);
    expect((await as(LAPSED, "POST", "/pro/trade/build", { mint: MINT, side: "sell" })).statusCode).toBe(404);
  });

  it("changes no one's standing when a scan fails", async () => {
    await expect(refreshProHolders({ getTopHoldersBatch: async () => new Map() })).rejects.toThrow();
    // Each reader's reason, in order.
    await expect(
      refreshProHolders([
        {
          getTopHoldersBatch: async (mints) =>
            new Map(mints.map((m) => [m, { status: "failed", reason: "token accounts unreadable" }])),
        },
        { getTopHoldersBatch: async () => new Map() },
      ]),
    ).rejects.toThrow("(token accounts unreadable; no answer)");
    resetProHolderCacheForTests();
    expect(await me(HOLDER)).toMatchObject({ isPro: true, proMode: { source: "holder" } });
  });

  it("keeps a returning holder's run, and ends the grace of one that moved its bag", async () => {
    const mover = walletKey();
    const at = new Date(Date.now() + 10 * 60_000);
    // Held for hours until twenty minutes ago, and now holds next to nothing.
    await prisma.proHolder.create({
      data: {
        walletAddress: mover,
        rank: 200,
        lastInTopAt: new Date(at.getTime() - 20 * 60_000),
        inTopSince: new Date(at.getTime() - 5 * 3_600_000),
      },
    });
    const before = await prisma.proHolder.findUnique({ where: { walletAddress: GRACE } });
    const fillers = Array.from({ length: 248 }, () => ({ owner: walletKey(), pct: 0.1 }));
    await refreshProHolders(
      {
        getTopHoldersBatch: async (mints) =>
          new Map(
            mints.map((m) => [
              m,
              {
                status: "found",
                holders: [
                  { owner: HOLDER, pct: 5 },
                  { owner: GRACE, pct: 1 },
                  ...fillers,
                  { owner: mover, pct: 0.01 },
                ],
                supply: "1000000000000000",
              },
            ]),
          ),
      },
      at,
    );
    // The grace wallet is back in the top 250: its qualifying run carries on, no new hour.
    const after = await prisma.proHolder.findUnique({ where: { walletAddress: GRACE } });
    expect(after!.inTopSince.getTime()).toBe(before!.inTopSince.getTime());
    expect(await proHolderStanding(GRACE, at)).toMatchObject({ state: "top" });
    // The mover holds under half the 250th wallet's share: no grace for it.
    expect(await proHolderStanding(mover, at)).toEqual({ state: "none" });
    // The 250th wallet's 0.1% of supply is what it takes to get in.
    expect((await proHolderRank(HOLDER, at)).cutoffRaw).toBe("1000000000000");
    resetProHolderCacheForTests();
  });

  it("gives the first scan's holders Pro Mode at once, and newcomers at their first scan", async () => {
    await prisma.proHolder.deleteMany({});
    resetProHolderCacheForTests();
    const first = new Date();
    const scan = (owners: string[], at: Date) =>
      refreshProHolders(
        {
          getTopHoldersBatch: async (mints) =>
            new Map(mints.map((m) => [m, { status: "found", holders: owners.map((owner) => ({ owner })) }])),
        },
        at,
      );
    await scan([HOLDER], first);
    expect(await proHolderStanding(HOLDER, first)).toMatchObject({ state: "top", rank: 1 });
    const next = new Date(first.getTime() + 5 * 60_000);
    await scan([HOLDER, NEWBIE], next);
    expect(await proHolderStanding(HOLDER, next)).toMatchObject({ state: "top" });
    expect(await proHolderStanding(NEWBIE, next)).toMatchObject({ state: "top", rank: 2 });
    resetProHolderCacheForTests();
  });

  it("runs a Check now scan under the scan's lock when the newest scan is over a minute old", async () => {
    await prisma.proHolder.deleteMany({});
    resetProHolderCacheForTests();
    let reads = 0;
    const reader = {
      getTopHoldersBatch: async (mints: string[]) => {
        reads += 1;
        return new Map(mints.map((m) => [m, { status: "found", holders: [{ owner: NEWBIE }] }]));
      },
    };
    expect(await refreshProHoldersOnDemand(reader)).toEqual({ scanned: true });
    expect(reads).toBe(1);
    expect(await proHolderStanding(NEWBIE)).toMatchObject({ state: "top", rank: 1 });
    // A second press straight after reads that scan.
    expect(await refreshProHoldersOnDemand(reader)).toEqual({ scanned: false });
    expect(reads).toBe(1);
    resetProHolderCacheForTests();
  });
});

/**
 * A holder-scan outage (user decision 2026-10-19): the last scan's wallets keep Pro Mode until the
 * scans resume, and one missing from the first scan back gets its whole day of grace from that scan.
 */
describe.skipIf(!dbAvailable)("Pro Mode for the top holders through a scan outage", () => {
  const STAYS = walletKey();
  const EARLY = walletKey();
  const LATE = walletKey();
  const NEVER = walletKey();
  const HOUR = 3_600_000;
  const t0 = new Date(Date.now() - 48 * HOUR);
  const before = new Date(t0.getTime() + 5 * 60_000);
  const resumed = new Date(t0.getTime() + 40 * HOUR);
  const scan = async (at: Date, owners: string[]) => {
    await refreshProHolders(
      {
        getTopHoldersBatch: async (mints) =>
          new Map(mints.map((m) => [m, { status: "found", holders: owners.map((owner) => ({ owner })) }])),
      },
      at,
    );
    resetProHolderCacheForTests();
  };

  beforeAll(async () => {
    await prisma.proHolder.deleteMany({});
    resetProHolderCacheForTests();
    await scan(t0, [STAYS, EARLY, LATE]);
    // EARLY drops out at a fresh scan, then the scans stop for 40 hours.
    await scan(before, [STAYS, LATE]);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.proHolder.deleteMany({});
    resetProHolderCacheForTests();
  });

  it("keeps Pro Mode for the last scan's wallets a day and more into the outage", async () => {
    for (const hours of [2, 25, 39]) {
      const at = new Date(before.getTime() + hours * HOUR);
      expect(await proHolderStanding(STAYS, at)).toMatchObject({ state: "top", rank: 1 });
      expect(await proHolderStanding(LATE, at)).toMatchObject({ state: "top", rank: 2 });
    }
    expect((await proHolderSummary(new Date(before.getTime() + 25 * HOUR))).stale).toBe(true);
  });

  it("keeps the clock of a wallet that dropped out before the outage", async () => {
    // Its day runs from the last scan it was in, outage or not.
    expect(await proHolderStanding(EARLY, new Date(before.getTime() + 2 * HOUR))).toEqual({
      state: "grace",
      rank: 2,
      graceEndsAt: new Date(t0.getTime() + 24 * HOUR),
      stale: false,
    });
    expect(await proHolderStanding(EARLY, new Date(t0.getTime() + 24 * HOUR + 60_000))).toEqual({
      state: "none",
    });
  });

  it("starts the grace of a wallet missing from the first scan back at that scan", async () => {
    await scan(resumed, [STAYS]);
    const graceEndsAt = new Date(resumed.getTime() + 24 * HOUR);
    expect(await proHolderStanding(LATE, new Date(resumed.getTime() + 23 * HOUR))).toEqual({
      state: "grace",
      rank: 2,
      graceEndsAt,
      stale: false,
    });
    expect(await proHolderStanding(LATE, new Date(graceEndsAt.getTime() + 60_000))).toEqual({
      state: "none",
    });
    expect(await proHolderStanding(STAYS, resumed)).toMatchObject({ state: "top", rank: 1 });
    // Admin lists it with the same end; the wallet that dropped out before the outage is done.
    const summary = await proHolderSummary(new Date(resumed.getTime() + HOUR));
    expect(summary.grace).toEqual([{ walletAddress: LATE, rank: 2, graceEndsAt }]);
    // The scan back left the earlier wallet's clock alone.
    expect(await proHolderStanding(EARLY, resumed)).toEqual({ state: "none" });
    const early = await prisma.proHolder.findUnique({ where: { walletAddress: EARLY } });
    expect(early!.graceFrom).toEqual(t0);
  });

  it("clears the grace of a wallet back in the top 250", async () => {
    const back = new Date(resumed.getTime() + 5 * 60_000);
    await scan(back, [STAYS, LATE]);
    expect(await proHolderStanding(LATE, back)).toMatchObject({ state: "top", rank: 2 });
    const late = await prisma.proHolder.findUnique({ where: { walletAddress: LATE } });
    expect(late!.graceFrom).toBeNull();
  });

  it("changes nothing for a wallet never in the top 250", async () => {
    for (const at of [before, new Date(before.getTime() + 30 * HOUR), resumed])
      expect(await proHolderStanding(NEVER, at)).toEqual({ state: "none" });
    expect(await prisma.proHolder.findUnique({ where: { walletAddress: NEVER } })).toBeNull();
  });
});

/**
 * Privy's confirm window is skipped only on a coin the wallet holds, that passed the safety
 * screen, or that a model called (user rule 2026-10-18); anything else asks.
 */
describe.skipIf(!dbAvailable)("quietSign", () => {
  const tag = `quiet-sign-${Date.now()}`;
  const wallet = `${tag}-wallet`;
  const mints = {
    unknown: `${tag}-unknown`,
    screened: `${tag}-screened`,
    failed: `${tag}-failed`,
    called: `${tag}-called`,
    held: `${tag}-held`,
    rejected: `${tag}-rejected`,
  };
  const rpc = {
    getTokenBalance: async (_owner: string, mint: string) =>
      mint === mints.held ? { raw: 5n, decimals: 6, accounts: [] } : { raw: 0n, decimals: 6, accounts: [] },
  };

  beforeAll(async () => {
    const token = (mint: string, data: Record<string, unknown> = {}) =>
      prisma.token.create({ data: { mintAddress: mint, ...data }, select: { id: true } });
    const screened = await token(mints.screened);
    await prisma.tokenSnapshot.create({
      data: { tokenId: screened.id, priceUsd: 1, marketCapUsd: 1, rugScreenPassed: true },
    });
    // Passed once, failed on its latest scan.
    const failed = await token(mints.failed);
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: failed.id,
        priceUsd: 1,
        marketCapUsd: 1,
        rugScreenPassed: true,
        takenAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.tokenSnapshot.create({
      data: { tokenId: failed.id, priceUsd: 1, marketCapUsd: 1, rugScreenPassed: false },
    });
    const rejected = await token(mints.rejected, { screenRejectedAt: new Date() });
    await prisma.tokenSnapshot.create({
      data: { tokenId: rejected.id, priceUsd: 1, marketCapUsd: 1, rugScreenPassed: true },
    });
    const called = await token(mints.called);
    await prisma.curatedAlert.create({
      data: { tokenId: called.id, source: "test", confidence: 50, anchorPriceUsd: 1, anchorMcapUsd: 1 },
    });
  });
  afterAll(async () => {
    if (dbAvailable) await prisma.token.deleteMany({ where: { mintAddress: { startsWith: tag } } });
  });

  it("skips the window only for held, screened or called coins", async () => {
    expect(await quietSign(rpc, wallet, mints.unknown, "buy")).toBe(false);
    expect(await quietSign(rpc, wallet, mints.failed, "buy")).toBe(false);
    expect(await quietSign(rpc, wallet, mints.rejected, "buy")).toBe(false);
    expect(await quietSign(rpc, wallet, mints.screened, "buy")).toBe(true);
    expect(await quietSign(rpc, wallet, mints.called, "buy")).toBe(true);
    expect(await quietSign(rpc, wallet, mints.held, "buy")).toBe(true);
    // A sale is of a coin the wallet holds.
    expect(await quietSign(rpc, wallet, mints.unknown, "sell")).toBe(true);
  });
  it("asks when the balance can't be read", async () => {
    const down = { getTokenBalance: async () => Promise.reject(new Error("down")) };
    expect(await quietSign(down, wallet, mints.unknown, "buy")).toBe(false);
  });
});
