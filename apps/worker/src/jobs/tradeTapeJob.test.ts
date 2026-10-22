// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  HttpError,
  prisma,
  rememberLaunchTapeSeed,
  tradesFromPumpFun,
  type ChainTx,
  type PumpFunTradesPage,
} from "@trenchscanner/core";
import {
  heliusNewestPagesPerRun,
  heliusPagesLeft,
  pendingCalledCoins,
  resetTradeTapeState,
  runTradeTapeJob,
  saveTradeTapeProgress,
  stoppedAtOf,
  type TradeTapeDeps,
} from "./tradeTapeJob.js";

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

describe("heliusPagesLeft", () => {
  it("estimates the pages left at the pace of the last five", () => {
    expect(heliusPagesLeft([0, 1_000, 2_000, 3_000, 4_000], 60_000)).toBeNull(); // too few pages yet
    // Five pages in the last 50 s: 10 s a page, 600 s to go.
    expect(heliusPagesLeft([0, 0, 10_000, 20_000, 30_000, 40_000, 50_000], 650_000)).toBe(60);
    // Pages within one block time read as a second's worth.
    expect(heliusPagesLeft([5_000, 5_000, 5_000, 5_000, 5_000, 5_000], 6_000)).toBe(5);
    expect(heliusPagesLeft([0, 1, 2, 3, 4, 70_000], 60_000)).toBe(0);
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

  it("starts a Helius tape after the launch-buyer pages already paid for", async () => {
    const { token } = await seedCalled("seeded", new Date(ANCHOR + 5 * MIN));
    const mint = token.mintAddress;
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    const sniper = "4WPT9wLwQWYS5zyX36ZgoY3ESxxLgDmE12upKXDAyYbL";
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
    rememberLaunchTapeSeed(mint, {
      txs: [tx(LAUNCH, dev, 0, 30_000_000, -1e9)],
      pages: 1,
      pageEnds: [LAUNCH],
      paginationToken: "1",
    });
    const asked: (string | undefined)[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        if (m !== mint) return { status: "failed" };
        asked.push(opts?.paginationToken);
        return {
          status: "ok",
          txs: [tx(ANCHOR + MIN, sniper, 0, 1, -1e9)],
          paginationToken: null,
        };
      },
    };
    const { stub } = pumpFunStub("none", []);
    const meta = await runTradeTapeJob(
      { helius, pumpFun: stub },
      { heliusPagesPerRun: 1, pumpFunCallsPerRun: 0, now: () => NOW },
    );
    expect(asked).toEqual(["1"]);
    expect(meta.heliusPages).toBe(1);
    const tape = await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } });
    expect(tape).toMatchObject({ status: "done", source: "helius", creator: dev, trades: 2 });
  });

  it("leaves a coin Helius failed on twice to Pump.fun", async () => {
    const failed = await seedCalled("helius-failed", null);
    const fresh = await seedCalled("fresh", null);
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: failed.token.id,
        anchorAt: new Date(ANCHOR),
        reason: "called",
        status: "failed",
        source: "helius:failed",
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
  it("hands a busy coin off early, then reads it newest first to meet the pages it kept", async () => {
    const busy = await seedCalled("busy", null);
    const mint = busy.token.mintAddress;
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    // A page every second from the launch, against a window that runs 33 minutes: ~2,000 pages.
    const asked: string[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        asked.push(m);
        const i = opts?.paginationToken ? Number(opts.paginationToken) : 0;
        return {
          status: "ok",
          paginationToken: String(i + 1),
          txs: [
            {
              blockTime: LAUNCH / 1000 + i,
              transaction: { signatures: [`busy-${i}`], message: { accountKeys: [dev, "ata"] } },
              meta: {
                err: null,
                preTokenBalances:
                  i === 0
                    ? []
                    : [
                        {
                          accountIndex: 1,
                          mint: m,
                          owner: dev,
                          uiTokenAmount: { amount: String(i * 1e6), decimals: 6 },
                        },
                      ],
                postTokenBalances: [
                  {
                    accountIndex: 1,
                    mint: m,
                    owner: dev,
                    uiTokenAmount: { amount: String((i + 1) * 1e6), decimals: 6 },
                  },
                ],
                preBalances: [10e9, 0],
                postBalances: [9e9, 0],
              },
            },
          ],
        };
      },
    };
    const none = pumpFunStub("none", []);
    let now = NOW;
    const meta = await runTradeTapeJob(
      { helius, pumpFun: none.stub },
      { heliusPagesPerRun: 50, pumpFunCallsPerRun: 0, now: () => now },
    );
    expect(meta.handedOff).toBe(1);
    expect(asked.filter((m) => m === mint)).toHaveLength(10); // not 100
    const handed = await prisma.tokenTradeTape.findUnique({ where: { tokenId: busy.token.id } });
    expect(handed).toMatchObject({ status: "failed", source: "helius:busy", calls: 10 });
    expect(handed!.retryAt!.getTime()).toBeLessThanOrEqual(now);

    // Next run: Pump.fun has the lane's other end, and Helius reads it newest first from the
    // window's end, until it meets the ten launch-side pages the hand-off kept: one whole tape.
    now += MIN;
    asked.length = 0;
    const newestAsked: (string | undefined)[] = [];
    const meeting: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        if (!opts?.newest) return helius.getMintTransactionsPage(m, opts);
        newestAsked.push(opts.paginationToken);
        const i = opts.paginationToken ? Number(opts.paginationToken) : 0;
        // Two seconds a page, back from the 30th second: page 11 reaches before the 9th.
        const atS = LAUNCH / 1000 + 30 - 2 * i;
        return {
          status: "ok",
          paginationToken: String(i + 1),
          txs: [
            {
              blockTime: atS,
              transaction: { signatures: [`busy-new-${i}`], message: { accountKeys: [dev, "ata"] } },
              meta: {
                err: null,
                preTokenBalances: [
                  { accountIndex: 1, mint: m, owner: dev, uiTokenAmount: { amount: "1000000", decimals: 6 } },
                ],
                postTokenBalances: [
                  { accountIndex: 1, mint: m, owner: dev, uiTokenAmount: { amount: "2000000", decimals: 6 } },
                ],
                preBalances: [10e9, 0],
                postBalances: [9e9, 0],
              },
            },
          ],
        };
      },
    };
    const origin: TradeTapeDeps["pumpFun"] = {
      coinOrigin: async () => null,
      coinTrades: async () => null,
    };
    await runTradeTapeJob(
      { helius: meeting, pumpFun: origin },
      { heliusPagesPerRun: 50, pumpFunCallsPerRun: 4, spacingMs: 0, now: () => now },
    );
    expect(asked).not.toContain(mint); // nothing from the launch again
    expect(newestAsked).toHaveLength(12);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: busy.token.id } })).toMatchObject({
      status: "done",
      source: "helius",
      creator: dev,
      trades: 22,
    });
  });

  it("reads a busy coin with no hand-off newest first, and stores it as partial at the cap", async () => {
    const busy = await seedCalled("busy-cold", null);
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: busy.token.id,
        anchorAt: new Date(ANCHOR),
        reason: "called",
        status: "failed",
        source: "helius:busy",
        windowEnd: new Date(ANCHOR + 30 * MIN),
        retryAt: new Date(NOW - MIN),
      },
    });
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    const modes: boolean[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        if (m !== busy.token.mintAddress) return { status: "ok", txs: [], paginationToken: null };
        modes.push(Boolean(opts?.newest));
        const i = opts?.paginationToken ? Number(opts.paginationToken) : 0;
        return {
          status: "ok",
          paginationToken: String(i + 1),
          txs: [
            {
              blockTime: (ANCHOR + 30 * MIN) / 1000 - i,
              transaction: { signatures: [`cold-${i}`], message: { accountKeys: [dev, "ata"] } },
              meta: {
                err: null,
                preTokenBalances: [
                  { accountIndex: 1, mint: m, owner: dev, uiTokenAmount: { amount: "2000000", decimals: 6 } },
                ],
                postTokenBalances: [
                  { accountIndex: 1, mint: m, owner: dev, uiTokenAmount: { amount: "1000000", decimals: 6 } },
                ],
                preBalances: [9e9, 0],
                postBalances: [10e9, 0],
              },
            },
          ],
        };
      },
    };
    const none = pumpFunStub("none", []);
    const opts = { heliusPagesPerRun: 50, pumpFunCallsPerRun: 0, now: () => NOW };
    // A third of the run's pages at most (16 of 50), carried over to the next run.
    const first = await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(first.heliusNewestPages).toBe(16);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: busy.token.id } })).toMatchObject({
      status: "failed",
    });
    await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(modes).toHaveLength(30);
    expect(modes.every(Boolean)).toBe(true);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: busy.token.id } })).toMatchObject({
      status: "partial",
      source: "helius",
      calls: 30,
      trades: 30,
    });
  });

  it("reads a coin Helius failed once on Helius again, and gives up on the second failure", async () => {
    const once = await seedCalled("helius-once", null);
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: once.token.id,
        anchorAt: new Date(ANCHOR),
        reason: "called",
        status: "failed",
        source: "helius",
        windowEnd: new Date(ANCHOR + 30 * MIN),
        retryAt: new Date(NOW - MIN),
      },
    });
    const asked: string[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m) => {
        if (m !== once.token.mintAddress) return { status: "ok", txs: [], paginationToken: null };
        asked.push(m);
        return { status: "failed" };
      },
    };
    const none = pumpFunStub("none", []);
    for (let run = 0; run < 3; run += 1) {
      await runTradeTapeJob(
        { helius, pumpFun: none.stub },
        { heliusPagesPerRun: 5, pumpFunCallsPerRun: 0, now: () => NOW },
      );
    }
    expect(asked).toHaveLength(3);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: once.token.id } })).toMatchObject({
      status: "failed",
      source: "helius:failed",
    });
  });

  it("saves a read at shutdown and finishes it in the next process", async () => {
    const { token } = await seedCalled("saved", null);
    const mint = token.mintAddress;
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    const tx = (atMs: number, sig: string): ChainTx => ({
      blockTime: atMs / 1000,
      transaction: { signatures: [sig], message: { accountKeys: [dev, "ata"] } },
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint, owner: dev, uiTokenAmount: { amount: "1000000" } }],
        preBalances: [2e9, 0],
        postBalances: [1e9, 0],
      },
    });
    const asked: (string | undefined)[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        if (m !== mint) return { status: "ok", txs: [], paginationToken: null };
        asked.push(opts?.paginationToken);
        return opts?.paginationToken
          ? { status: "ok", txs: [tx(ANCHOR, "s2")], paginationToken: null }
          : { status: "ok", txs: [tx(LAUNCH, "s1")], paginationToken: "p2" };
      },
    };
    const none = pumpFunStub("none", []);
    const opts = { heliusPagesPerRun: 1, pumpFunCallsPerRun: 0, now: () => NOW };
    await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(await saveTradeTapeProgress()).toBe(1);
    resetTradeTapeState(); // a new process
    await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(asked).toEqual([undefined, "p2"]);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: token.id } })).toMatchObject({
      status: "done",
      source: "helius",
      trades: 2,
    });
    expect(await prisma.tradeTapeProgress.count()).toBe(0);
  });

  it("saves a read in progress after every run, so a crash loses at most a run, but leaves another coin's save", async () => {
    const { token } = await seedCalled("crashed", null);
    const mint = token.mintAddress;
    const asked: (string | undefined)[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        if (m !== mint) return { status: "ok", txs: [], paginationToken: null };
        asked.push(opts?.paginationToken);
        return { status: "ok", txs: [], paginationToken: opts?.paginationToken ? null : "p2" };
      },
    };
    const none = pumpFunStub("none", []);
    const opts = { heliusPagesPerRun: 1, pumpFunCallsPerRun: 0, now: () => NOW };
    await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(await prisma.tradeTapeProgress.findUnique({ where: { lane: "helius" } })).toMatchObject({
      tokenId: token.id,
    });
    // Another process's save for a different coin is not overwritten.
    await prisma.tradeTapeProgress.update({ where: { lane: "helius" }, data: { tokenId: "other" } });
    expect(await saveTradeTapeProgress({ keepOthers: true })).toBe(0);
    expect((await prisma.tradeTapeProgress.findUnique({ where: { lane: "helius" } }))?.tokenId).toBe("other");
    await prisma.tradeTapeProgress.update({ where: { lane: "helius" }, data: { tokenId: token.id } });
    resetTradeTapeState(); // killed without a shutdown
    await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(asked).toEqual([undefined, "p2"]);
  });

  it("keeps a coin whose Helius page failed, and asks for the page again next run", async () => {
    const flaky = await seedCalled("flaky", null);
    const mint = flaky.token.mintAddress;
    const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
    let calls = 0;
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m) => {
        if (m !== mint) return { status: "ok", txs: [], paginationToken: null };
        calls += 1;
        if (calls === 1) return { status: "failed" };
        return {
          status: "ok",
          paginationToken: null,
          txs: [
            {
              blockTime: LAUNCH / 1000,
              transaction: { signatures: ["f"], message: { accountKeys: [dev, "ata"] } },
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
    const none = pumpFunStub("none", []);
    const first = await runTradeTapeJob(
      { helius, pumpFun: none.stub },
      { heliusPagesPerRun: 10, pumpFunCallsPerRun: 0, now: () => NOW },
    );
    expect(first.heliusPages).toBe(1); // stopped for the run, not three tries in a row
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: flaky.token.id } })).toBeNull();
    await runTradeTapeJob(
      { helius, pumpFun: none.stub },
      { heliusPagesPerRun: 10, pumpFunCallsPerRun: 0, now: () => NOW },
    );
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: flaky.token.id } })).toMatchObject({
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

describe("heliusNewestPagesPerRun", () => {
  it("leaves the newest-first reads a third of the run's pages, rounded down", () => {
    expect(heliusNewestPagesPerRun(30)).toBe(10);
    expect(heliusNewestPagesPerRun(50)).toBe(16);
    expect(heliusNewestPagesPerRun(2)).toBe(0);
  });
});

/**
 * The newest-first reads' cap and order (user decision 2026-10-20, Helius audit), years past the
 * other tests' coins so no other row is in their lookbacks.
 */
describe.skipIf(!dbAvailable)("trade tape job: newest-first reads", () => {
  const BASE = Date.parse("2031-03-01T12:00:00Z");
  const dev = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
  const PRICES = { peak1hPriceUsd: 1, low1hPriceUsd: 1, lowBefore2xPriceUsd: 1, peak24hPriceUsd: 1 };
  beforeEach(() => resetTradeTapeState());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.tradingPosition.deleteMany({ where: { mint: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  const token = (label: string) =>
    prisma.token.create({ data: { mintAddress: `${TAG}-${label}`, symbol: "T" } });

  async function seedCall(label: string, anchorMs: number, busy: boolean) {
    const t = await token(label);
    const row = await prisma.candidateOutcome.create({
      data: {
        tokenId: t.id,
        anchorAt: new Date(anchorMs),
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        ...PRICES,
        features: {},
        sampleKind: "emission",
        labelRule: 4,
        nextCheckAt: new Date(anchorMs),
        finalizedAt: new Date(anchorMs + 30 * MIN),
      },
    });
    await prisma.curatedAlert.create({
      data: {
        tokenId: t.id,
        candidateOutcomeId: row.id,
        source: "model",
        confidence: 0.5,
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        createdAt: new Date(anchorMs),
      },
    });
    if (busy) {
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: t.id,
          outcomeId: row.id,
          anchorAt: new Date(anchorMs),
          reason: "called",
          status: "failed",
          source: "helius:busy",
          windowEnd: new Date(anchorMs + 30 * MIN),
          retryAt: new Date(anchorMs),
        },
      });
    }
    return t;
  }

  async function seedTraded(label: string, openedAtMs: number) {
    const t = await token(label);
    await prisma.tradingPosition.create({
      data: {
        userId: `${TAG}-trader`,
        mint: t.mintAddress,
        sourceKind: "model",
        sourceRef: "rules",
        sourceLabel: "Model: Rules",
        signalAt: new Date(openedAtMs),
        status: "closed",
        exitPlan: {},
        openedAt: new Date(openedAtMs),
      },
    });
    return t;
  }

  async function seedFilter(label: string) {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${label}` } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id, name: label } });
    return async (t: { id: string }, atMs: number) => {
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId: t.id, takenAt: new Date(atMs), priceUsd: 1, marketCapUsd: 10_000, score: 70 },
      });
      await prisma.match.create({
        data: {
          userId: user.id,
          filterId: filter.id,
          tokenId: t.id,
          snapshotId: snapshot.id,
          matchedAt: new Date(atMs),
          score: 70,
        },
      });
    };
  }

  /** Decision moments on `n` coins over the day before `atMs`: a filter is narrow under 5% of them. */
  async function seedEvents(label: string, n: number, atMs: number) {
    for (let i = 0; i < n; i += 1) {
      const t = await token(`${label}-${i}`);
      await prisma.candidateOutcome.create({
        data: {
          tokenId: t.id,
          anchorAt: new Date(atMs - (i + 1) * MIN),
          anchorPriceUsd: 1,
          anchorMcapUsd: 10_000,
          ...PRICES,
          features: {},
          sampleKind: "event",
          nextCheckAt: new Date(atMs),
        },
      });
    }
  }

  /** One buy a page, newest first back from the window's end, `pages` pages (endless when absent). */
  function newestHelius(pagesOf: (mint: string) => number | undefined) {
    const asked: { mint: string; newest: boolean }[] = [];
    const helius: TradeTapeDeps["helius"] = {
      gtfaUsable: true,
      takeCallStats: () => ({}),
      getMintTransactionsPage: async (m, opts) => {
        asked.push({ mint: m, newest: Boolean(opts?.newest) });
        const i = opts?.paginationToken ? Number(opts.paginationToken) : 0;
        const pages = pagesOf(m);
        return {
          status: "ok",
          paginationToken: pages !== undefined && i + 1 >= pages ? null : String(i + 1),
          txs: [
            {
              blockTime: opts!.untilBlockTime! - i,
              transaction: { signatures: [`${m}-${i}`], message: { accountKeys: [dev, "ata"] } },
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
    return { helius, asked };
  }

  it("reads traded coins first, then busy called ones, then narrow filters' matches, and skips a broad filter's", async () => {
    const at = BASE - 60 * MIN;
    const traded = await seedTraded("o-traded", at);
    const busy = await seedCall("o-busy", at, true);
    const narrow = await token("o-narrow");
    const broad = await token("o-broad");
    const broad2 = await token("o-broad2");
    // 40 coins with a decision moment: a filter matching 2 coins (5%) is broad, 1 is narrow.
    await seedEvents("o-event", 40, BASE);
    await (
      await seedFilter("o-narrow-filter")
    )(narrow, at);
    const broadMatch = await seedFilter("o-broad-filter");
    await broadMatch(broad, at);
    await broadMatch(broad2, at + MIN);

    const ours = new Set([traded, busy, narrow, broad, broad2].map((t) => t.mintAddress));
    const { helius, asked } = newestHelius((m) => (ours.has(m) ? 1 : 0));
    const none = pumpFunStub("none", []);
    const meta = await runTradeTapeJob(
      { helius, pumpFun: none.stub },
      { heliusPagesPerRun: 30, pumpFunCallsPerRun: 0, now: () => BASE },
    );
    expect(asked.filter((a) => ours.has(a.mint))).toEqual([
      { mint: traded.mintAddress, newest: true },
      { mint: busy.mintAddress, newest: true },
      { mint: narrow.mintAddress, newest: true },
    ]);
    expect(meta.heliusNewestPages).toBe(asked.length);

    const tapeOf = (t: { id: string }) => prisma.tokenTradeTape.findUnique({ where: { tokenId: t.id } });
    // New to the tape: no outcome row, anchored at the first buy or match, no stop cause.
    expect(await tapeOf(traded)).toMatchObject({
      reason: "traded",
      outcomeId: null,
      source: "helius",
      anchorAt: new Date(at),
      windowEnd: new Date(at + 30 * MIN),
      trades: 1,
      wallets: 1,
    });
    expect(await tapeOf(narrow)).toMatchObject({ reason: "matched", outcomeId: null, trades: 1 });
    expect(await tapeOf(busy)).toMatchObject({ reason: "called", source: "helius" });
    expect(await tapeOf(broad)).toBeNull();
    expect(await tapeOf(broad2)).toBeNull();
    const wallet = await prisma.tokenWalletActivity.findFirst({ where: { tokenId: traded.id } });
    expect(wallet).toMatchObject({ wallet: dev, buys: 1, dumpedIntoStop: false });

    // A later call on a traded coin still gets its own read from the launch.
    const row = await prisma.candidateOutcome.create({
      data: {
        tokenId: traded.id,
        anchorAt: new Date(BASE),
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        ...PRICES,
        features: {},
        sampleKind: "emission",
        nextCheckAt: new Date(BASE),
        finalizedAt: new Date(BASE + 30 * MIN),
      },
    });
    await prisma.curatedAlert.create({
      data: {
        tokenId: traded.id,
        candidateOutcomeId: row.id,
        source: "model",
        confidence: 0.5,
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        createdAt: new Date(BASE),
      },
    });
    const called = await pendingCalledCoins(BASE + 40 * MIN);
    expect(called.find((c) => c.tokenId === traded.id)).toMatchObject({
      reason: "called",
      refOutcomeId: row.id,
      failedSource: null,
    });
  });

  it("caps newest-first reads at a third of the run's pages, after the from-launch reads", async () => {
    const base = BASE + 30 * 24 * 60 * MIN;
    const busy = await seedCall("c-busy", base - 60 * MIN, true);
    const { helius, asked } = newestHelius(() => undefined);
    const none = pumpFunStub("none", []);
    const opts = { heliusPagesPerRun: 30, pumpFunCallsPerRun: 0, now: () => base };
    const first = await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(first).toMatchObject({ heliusPages: 10, heliusNewestPages: 10 });

    // A new call while the busy coin is part read: read from its launch first, with the run's pages
    // it needs (25), and the busy coin gets what is left (5), not its third.
    const fresh = await seedCall("c-fresh", base - 40 * MIN, false);
    const launchAt = base - 43 * MIN;
    const fromLaunch: TradeTapeDeps["helius"] = {
      ...helius,
      getMintTransactionsPage: async (m, o) => {
        if (o?.newest || m !== fresh.mintAddress) return helius.getMintTransactionsPage(m, o);
        asked.push({ mint: m, newest: false });
        const i = o?.paginationToken ? Number(o.paginationToken) : 0;
        return {
          status: "ok",
          paginationToken: i + 1 >= 25 ? null : String(i + 1),
          txs: [
            {
              blockTime: launchAt / 1000 + 75 * i,
              transaction: { signatures: [`fresh-${i}`], message: { accountKeys: [dev, "ata"] } },
              meta: {
                err: null,
                preTokenBalances:
                  i === 0
                    ? []
                    : [
                        {
                          accountIndex: 1,
                          mint: m,
                          owner: dev,
                          uiTokenAmount: { amount: String(i * 1e6), decimals: 6 },
                        },
                      ],
                postTokenBalances: [
                  {
                    accountIndex: 1,
                    mint: m,
                    owner: dev,
                    uiTokenAmount: { amount: String((i + 1) * 1e6), decimals: 6 },
                  },
                ],
                preBalances: [10e9, 0],
                postBalances: [9e9, 0],
              },
            },
          ],
        };
      },
    };
    asked.length = 0;
    const second = await runTradeTapeJob({ helius: fromLaunch, pumpFun: none.stub }, opts);
    expect(second).toMatchObject({ heliusPages: 30, heliusNewestPages: 5, done: 1 });
    expect(asked.slice(0, 25).every((a) => a.mint === fresh.mintAddress && !a.newest)).toBe(true);
    expect(asked.slice(25).every((a) => a.mint === busy.mintAddress && a.newest)).toBe(true);
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: fresh.id } })).toMatchObject({
      status: "done",
      reason: "called",
      calls: 25,
    });

    // Nothing from the launch left: still a third, until the busy coin's 30 pages are read.
    const third = await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(third).toMatchObject({ heliusPages: 10, heliusNewestPages: 10 });
    const fourth = await runTradeTapeJob({ helius, pumpFun: none.stub }, opts);
    expect(fourth).toMatchObject({ heliusNewestPages: 5, partial: 1 });
    expect(await prisma.tokenTradeTape.findUnique({ where: { tokenId: busy.id } })).toMatchObject({
      status: "partial",
      source: "helius",
      calls: 30,
    });
  });
});
