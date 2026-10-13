// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  HttpError,
  prisma,
  tradesFromPumpFun,
  type ChainTx,
  type PumpFunTradesPage,
} from "@trenchscanner/core";
import { resetTradeTapeState, runTradeTapeJob, stoppedAtOf, type TradeTapeDeps } from "./tradeTapeJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `trade-tape-test-${Date.now()}`;
const MIN = 60_000;
const ANCHOR = Date.parse("2026-10-13T00:10:00Z");
const LAUNCH = ANCHOR - 3 * MIN;
const NOW = ANCHOR + 40 * MIN;

async function seedCalled(label: string, stoppedAt: Date | null) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${label}`, symbol: "T" } });
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      features: {},
      sampleKind: "emission",
      labelRule: 4,
      nextCheckAt: new Date(NOW),
      peak1hPriceUsd: 1.2,
      low1hPriceUsd: 0.4,
      lowBefore2xPriceUsd: 0.4,
      peak24hPriceUsd: 1.2,
      stoppedAt,
      finalizedAt: new Date(ANCHOR + 30 * MIN),
    },
  });
  await prisma.curatedAlert.create({
    data: {
      tokenId: token.id,
      candidateOutcomeId: row.id,
      source: "model",
      confidence: 0.5,
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      createdAt: new Date(ANCHOR),
    },
  });
  return { token, row };
}

const iso = (ms: number) => new Date(ms).toISOString();
const pumpTrade = (wallet: string, type: "buy" | "sell", sol: number, tokens: number, atMs: number) => ({
  tx: `${wallet}-${type}-${atMs}`,
  timestamp: iso(atMs),
  userAddress: wallet,
  type,
  amountSol: String(sol),
  baseAmount: String(tokens),
});

/** Pump.fun's answer for one coin, newest first, in pages of two. */
function pumpFunStub(
  mint: string,
  trades: ReturnType<typeof pumpTrade>[],
  opts: { throttleFirst?: boolean } = {},
) {
  const newestFirst = [...trades].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  let throttle = opts.throttleFirst ?? false;
  const calls: string[] = [];
  const stub: TradeTapeDeps["pumpFun"] = {
    coinOrigin: async (m) => (m === mint ? { creator: "dev", createdAt: new Date(LAUNCH) } : null),
    coinTrades: async (m, cursor): Promise<PumpFunTradesPage | null> => {
      if (m !== mint) return null;
      calls.push(cursor);
      if (throttle) {
        throttle = false;
        throw new HttpError(429, "x");
      }
      const before = Number(cursor.split("-")[1]);
      const page = newestFirst.filter((t) => Date.parse(t.timestamp) < before).slice(0, 2);
      const last = page[page.length - 1];
      const more = newestFirst.filter((t) => Date.parse(t.timestamp) < before).length > 2;
      return tradesFromPumpFun({
        trades: page,
        pagination:
          more && last
            ? { nextCursor: `x-${Date.parse(last.timestamp)}`, hasMore: true }
            : { hasMore: false },
      });
    },
  };
  return { stub, calls };
}

const noHelius: TradeTapeDeps["helius"] = {
  gtfaUsable: false,
  getMintTransactionsPage: async () => ({ status: "unsupported" }),
  takeCallStats: () => ({}),
};

describe("stoppedAtOf", () => {
  it("reads the rule-4 grade's stop when the row has one", () => {
    expect(stoppedAtOf({ stoppedAt: new Date(1), rule4Grade: { stoppedAt: null } })).toBeNull();
    expect(stoppedAtOf({ stoppedAt: new Date(1), rule4Grade: { stoppedAt: iso(5) } })?.getTime()).toBe(5);
    expect(stoppedAtOf({ stoppedAt: new Date(1), rule4Grade: null })?.getTime()).toBe(1);
  });
});

describe.skipIf(!dbAvailable)("trade tape job", () => {
  beforeEach(() => resetTradeTapeState());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("reads a called coin from Pump.fun and stores its wallets and stop cause", async () => {
    const stop = ANCHOR + 6 * MIN;
    const { token, row } = await seedCalled("pf", new Date(stop));
    const { stub, calls } = pumpFunStub(token.mintAddress, [
      pumpTrade("dev", "buy", 1, 30_000_000, LAUNCH),
      pumpTrade("sniper", "buy", 2, 60_000_000, LAUNCH + 2_000),
      pumpTrade("whale", "buy", 5, 50_000_000, LAUNCH + 2 * MIN),
      pumpTrade("sniper", "sell", 3, 60_000_000, ANCHOR + MIN),
      pumpTrade("whale", "sell", 1, 10_000_000, ANCHOR + 2 * MIN),
      // After the window: not read.
      pumpTrade("whale", "sell", 1, 40_000_000, ANCHOR + 45 * MIN),
    ]);
    const meta = await runTradeTapeJob(
      { helius: noHelius, pumpFun: stub },
      { heliusPagesPerRun: 4, pumpFunCallsPerRun: 10, spacingMs: 0, now: () => NOW },
    );
    expect(meta.done).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe(`${"9".repeat(26)}-${ANCHOR + 30 * MIN + 1_000}`);

    const tape = await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } });
    expect(tape).toMatchObject({ status: "done", source: "pumpfun", creator: "dev", trades: 5, wallets: 3 });
    const wallets = await prisma.tokenWalletActivity.findMany({ where: { tokenId: token.id } });
    const sniper = wallets.find((w) => w.wallet === "sniper")!;
    expect(sniper).toMatchObject({ firstBuyerRank: 1, launchSniper: true, dumpedIntoStop: true, dumpSol: 3 });
    expect(wallets.find((w) => w.wallet === "dev")!.isCreator).toBe(true);

    const outcome = await prisma.candidateOutcome.findUnique({ where: { id: row.id } });
    expect(outcome!.stopCause).toMatchObject({ sellers: 2, soldSol: 4, lead: "launchSnipers" });
  });

  it("pauses Pump.fun on a 429 and picks the coin up again next run", async () => {
    const { token } = await seedCalled("throttled", null);
    const { stub } = pumpFunStub(token.mintAddress, [pumpTrade("a", "buy", 1, 1_000_000, LAUNCH)], {
      throttleFirst: true,
    });
    let now = NOW;
    const deps = { helius: noHelius, pumpFun: stub };
    const opts = { heliusPagesPerRun: 0, pumpFunCallsPerRun: 10, spacingMs: 0, now: () => now };
    const first = await runTradeTapeJob(deps, opts);
    expect(first.throttled).toBe(1);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } })).toBeNull();
    now += 2 * MIN;
    const second = await runTradeTapeJob(deps, opts);
    expect(second.done).toBe(1);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } })).toMatchObject({
      status: "done",
    });
  });

  it("reads a recent called coin from Helius, page by page", async () => {
    const { token, row } = await seedCalled("helius", new Date(ANCHOR + 5 * MIN));
    const mint = token.mintAddress;
    const bal = (accountIndex: number, owner: string, amount: number) => ({
      accountIndex,
      mint,
      owner,
      uiTokenAmount: { amount: String(amount * 1e6), decimals: 6 },
    });
    const tx = (atMs: number, owner: string, pre: number, post: number, lamports: number): ChainTx => ({
      blockTime: atMs / 1000,
      transaction: { signatures: [`${owner}-${atMs}`], message: { accountKeys: [owner, "ata"] } },
      meta: {
        err: null,
        preTokenBalances: pre ? [bal(1, owner, pre)] : [],
        postTokenBalances: [bal(1, owner, post)],
        preBalances: [10e9, 0],
        postBalances: [10e9 + lamports, 0],
      },
    });
    // Real wallet addresses: program accounts (off the ed25519 curve) are left out of the tape.
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    const sniper = "4WPT9wLwQWYS5zyX36ZgoY3ESxxLgDmE12upKXDAyYbL";
    const late = "E8UYm3eH1vod7a2kpkWotNyosY2W7x6K9yCDZbkqwW12";
    const pages: ChainTx[][] = [
      [tx(LAUNCH, dev, 0, 30_000_000, -1e9), tx(LAUNCH + 1_000, sniper, 0, 50_000_000, -2e9)],
      [tx(ANCHOR + MIN, sniper, 50_000_000, 0, 2.5e9), tx(ANCHOR + 50 * MIN, late, 0, 1, -1e9)],
    ];
    const asked: (string | undefined)[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({ getTransactionsForAddress: asked.length }),
      getMintTransactionsPage: async (m, opts) => {
        if (m !== mint) return { status: "failed" };
        asked.push(opts?.paginationToken);
        const i = opts?.paginationToken ? Number(opts.paginationToken) : 0;
        return { status: "ok", txs: pages[i]!, paginationToken: String(i + 1) };
      },
    };
    const { stub } = pumpFunStub("none", []);
    const meta = await runTradeTapeJob(
      { helius, pumpFun: stub },
      { heliusPagesPerRun: 1, pumpFunCallsPerRun: 0, now: () => NOW },
    );
    // One page a run: carried over to the next.
    expect(meta.heliusPages).toBe(1);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } })).toBeNull();
    await runTradeTapeJob(
      { helius, pumpFun: stub },
      { heliusPagesPerRun: 1, pumpFunCallsPerRun: 0, now: () => NOW },
    );
    expect(asked).toEqual([undefined, "1"]);
    const tape = await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } });
    expect(tape).toMatchObject({ status: "done", source: "helius", creator: dev, trades: 3 });
    const outcome = await prisma.candidateOutcome.findUnique({ where: { id: row.id } });
    expect(outcome!.stopCause).toMatchObject({ sellers: 1, soldSol: 2.5, lead: "launchSnipers" });
  });

  it("leaves a coin Helius couldn't read to Pump.fun", async () => {
    const failed = await seedCalled("helius-failed", null);
    const fresh = await seedCalled("fresh", null);
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: failed.token.id,
        anchorAt: new Date(ANCHOR),
        reason: "called",
        status: "failed",
        source: "helius",
        windowEnd: new Date(ANCHOR + 30 * MIN),
        retryAt: new Date(NOW - MIN),
      },
    });
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    const asked: string[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m) => {
        asked.push(m);
        return {
          status: "ok",
          paginationToken: null,
          txs: [
            {
              blockTime: LAUNCH / 1000,
              transaction: { signatures: ["c"], message: { accountKeys: [dev, "ata"] } },
              meta: {
                err: null,
                preTokenBalances: [],
                postTokenBalances: [
                  { accountIndex: 1, mint: m, owner: dev, uiTokenAmount: { amount: "1000000", decimals: 6 } },
                ],
                preBalances: [2e9, 0],
                postBalances: [1e9, 0],
              },
            },
          ],
        };
      },
    };
    const { stub, calls } = pumpFunStub(failed.token.mintAddress, [
      pumpTrade("a", "buy", 1, 1_000_000, LAUNCH),
    ]);
    await runTradeTapeJob(
      { helius, pumpFun: stub },
      { heliusPagesPerRun: 1, pumpFunCallsPerRun: 4, spacingMs: 0, now: () => NOW },
    );
    expect(asked).toEqual([fresh.token.mintAddress]);
    expect(calls.length).toBeGreaterThan(0);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: failed.token.id } })).toMatchObject({
      status: "done",
      source: "pumpfun",
    });
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: fresh.token.id } })).toMatchObject({
      status: "done",
      source: "helius",
    });
  });
  it("has Helius read the newest call and Pump.fun the oldest, whatever their age", async () => {
    const older = await seedCalled("older", null);
    const newer = await seedCalled("newer", null);
    await prisma.curatedAlert.updateMany({
      where: { tokenId: newer.token.id },
      data: { createdAt: new Date(ANCHOR + MIN) },
    });
    const asked: string[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m) => {
        asked.push(m);
        return { status: "failed" };
      },
    };
    const { stub, calls } = pumpFunStub(older.token.mintAddress, [
      pumpTrade("a", "buy", 1, 1_000_000, LAUNCH),
    ]);
    // Days after the call: no longer "recent", and still Helius's to read.
    const meta = await runTradeTapeJob(
      { helius, pumpFun: stub },
      { heliusPagesPerRun: 1, pumpFunCallsPerRun: 4, spacingMs: 0, now: () => NOW + 3 * 24 * 60 * MIN },
    );
    expect(meta.heliusUsable).toBe(true);
    expect(asked).toEqual([newer.token.mintAddress]);
    expect(calls.length).toBeGreaterThan(0);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: older.token.id } })).toMatchObject({
      source: "pumpfun",
    });
  });
});
