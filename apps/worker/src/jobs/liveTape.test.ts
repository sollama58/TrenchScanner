import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveBuyersOf,
  liveBuyersOn,
  liveFlagsOf,
  liveLaunchBagsOf,
  livePageOf,
  liveWalletScoreOf,
  liveWalletScoreOn,
  liveWindowFlowOf,
  readLiveTape,
  resetLiveTape,
  STREAM_COVERAGE_MS,
  streamPageUsable,
  takeLiveTapeStats,
} from "./liveTape.js";
import type { StreamTapePage, TapeTrade } from "@trenchscanner/core";

const SOL = 1_000_000_000;
const MINT = "Mint1111111111111111111111111111111111111111";
// Real on-curve addresses: program accounts are left out of the tape.
const RISKY = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = "bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa";

function buyTx(wallet: string, sol: number, atSec: number) {
  return {
    blockTime: atSec,
    meta: {
      err: null,
      preBalances: [5 * SOL],
      postBalances: [5 * SOL - sol * SOL],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: wallet, uiTokenAmount: { amount: "1000000000", decimals: 6 } },
      ],
    },
    transaction: { signatures: [`sig-${atSec}`], message: { accountKeys: [wallet, "ata"] } },
  };
}

function fakeHelius() {
  return {
    gtfaUsable: true,
    getMintTransactionsPage: vi.fn(async () => ({
      status: "ok" as const,
      txs: [buyTx(RISKY, 2, 1_700_000_100)],
      paginationToken: null,
    })),
  };
}

describe("live tape", () => {
  beforeEach(() => resetLiveTape());
  const lookup = (w: string) => (w === RISKY ? { score: 90, dumps: 0 } : undefined);

  it("reads the newest page of the first coins due, and reads flagged buys from it", async () => {
    const helius = fakeHelius();
    await readLiveTape([MINT, "other", "third"], helius, { maxPages: 2, refreshMs: 60_000, nowMs: 1000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(2);
    expect(helius.getMintTransactionsPage).toHaveBeenCalledWith(MINT, { newest: true });
    expect(liveFlagsOf(MINT, lookup, 2000)).toMatchObject({ flaggedBuyers: 1, flaggedBuySol: 2 });
    expect(takeLiveTapeStats()).toMatchObject({ pages: 2, credits: 20 });

    // Not due again yet: no call.
    await readLiveTape([MINT], helius, { maxPages: 2, refreshMs: 60_000, nowMs: 30_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(2);
  });

  it("takes a bonding coin's page off the trade stream, every cycle, and pays Helius only past graduation", async () => {
    const helius = fakeHelius();
    const streamTrade = (wallet: string, atMs: number): TapeTrade => ({
      wallet,
      side: "buy",
      sol: 3,
      tokens: 1_000,
      atMs,
      tx: `stream-${atMs}`,
    });
    const page: StreamTapePage = {
      trades: [streamTrade(RISKY, 500)],
      sinceMs: 0,
      complete: true,
      bonding: true,
    };
    const streamed = vi.fn((mint: string) => (mint === MINT ? page : null));
    const opts = { maxPages: 2, refreshMs: 60_000, streamed };
    await readLiveTape([MINT, "other"], helius, { ...opts, nowMs: 1000 });
    // The bonding coin's page came off the stream; the other coin's from Helius.
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(1);
    expect(helius.getMintTransactionsPage).toHaveBeenCalledWith("other", { newest: true });
    expect(liveFlagsOf(MINT, lookup, 2000)).toMatchObject({ flaggedBuyers: 1, flaggedBuySol: 3 });
    expect(takeLiveTapeStats()).toMatchObject({ pages: 1, credits: 10, streamed: 1 });

    // Not due by age, but the stream's page is free and the block's: taken again, with its new trade.
    page.trades.push(streamTrade(OTHER, 1500));
    await readLiveTape([MINT], helius, { ...opts, nowMs: 2000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(1);
    expect(liveBuyersOf(MINT, 2500).sort()).toEqual([OTHER, RISKY].sort());

    // Graduated: the stream's page is the pool's now, so the next due read is Helius's.
    page.bonding = false;
    await readLiveTape([MINT], helius, { ...opts, nowMs: 3000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(1);
    await readLiveTape([MINT], helius, { ...opts, nowMs: 70_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(2);
    expect(helius.getMintTransactionsPage).toHaveBeenLastCalledWith(MINT, { newest: true });
  });

  it("stands a stream page in for Helius only when it says as much as a page would", () => {
    const trades = (n: number): TapeTrade[] =>
      Array.from({ length: n }, (_, i) => ({
        wallet: `w${i}`,
        side: "buy",
        sol: 1,
        tokens: 1,
        atMs: i,
        tx: `t${i}`,
      }));
    const now = 20 * 60_000;
    // Its whole history, a full page's worth, or long enough followed.
    expect(
      streamPageUsable({ trades: trades(1), sinceMs: now - 1000, complete: true, bonding: true }, now),
    ).toBe(true);
    expect(
      streamPageUsable({ trades: trades(100), sinceMs: now - 1000, complete: false, bonding: true }, now),
    ).toBe(true);
    expect(
      streamPageUsable(
        { trades: trades(5), sinceMs: now - STREAM_COVERAGE_MS, complete: false, bonding: true },
        now,
      ),
    ).toBe(true);
    // Joined late, thin and short: Helius's page says more.
    expect(
      streamPageUsable({ trades: trades(5), sinceMs: now - 60_000, complete: false, bonding: true }, now),
    ).toBe(false);
    // Past graduation: Helius, whatever the page holds.
    expect(streamPageUsable({ trades: trades(100), sinceMs: 0, complete: true, bonding: false }, now)).toBe(
      false,
    );
  });

  it("counts a failed page, but no credits for it", async () => {
    const helius = fakeHelius();
    helius.getMintTransactionsPage.mockResolvedValueOnce({ status: "failed" } as never);
    await readLiveTape([MINT, "other"], helius, { maxPages: 2, refreshMs: 60_000, nowMs: 1000 });
    expect(takeLiveTapeStats()).toMatchObject({ pages: 1, failed: 1, credits: 10 });
  });

  it("reads a coin with no page before re-reading one that has a page", async () => {
    const helius = fakeHelius();
    await readLiveTape([MINT], helius, { maxPages: 1, refreshMs: 60_000, nowMs: 0 });
    // MINT is due for a re-read and first in priority, but "fresh" has no page yet.
    await readLiveTape([MINT, "fresh"], helius, { maxPages: 1, refreshMs: 60_000, nowMs: 61_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenLastCalledWith("fresh", { newest: true });
    // With room for both, both are read.
    await readLiveTape([MINT, "third"], helius, { maxPages: 2, refreshMs: 60_000, nowMs: 62_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(4);
  });

  it("keeps a quiet coin's page instead of re-reading it (user decision 2026-10-20)", async () => {
    const helius = fakeHelius();
    const lastTrade = { at: 0 };
    const opts = {
      maxPages: 2,
      refreshMs: 60_000,
      quietSince: (_m: string, since: number) => lastTrade.at <= since,
    };
    await readLiveTape([MINT], helius, { ...opts, nowMs: 1000 });
    // Due, but no trade since the page: kept, and as of now, so it doesn't go stale.
    await readLiveTape([MINT], helius, { ...opts, nowMs: 61_000 });
    await readLiveTape([MINT], helius, { ...opts, nowMs: 20 * 60_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(1);
    expect(livePageOf(MINT, 21 * 60_000)).toBeDefined();
    // A trade since: read again once due.
    lastTrade.at = 20 * 60_000 + 1;
    await readLiveTape([MINT], helius, { ...opts, nowMs: 21 * 60_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(2);
  });

  it("is unknown without the scores or once the page is stale", async () => {
    await readLiveTape([MINT], fakeHelius(), { maxPages: 1, refreshMs: 60_000, nowMs: 0 });
    expect(liveFlagsOf(MINT, undefined, 1)).toBeNull();
    expect(liveFlagsOf(MINT, lookup, 16 * 60_000)).toBeNull();
  });

  it("reads the buyers' Wallet Score off the page, leaving out wallets on the coin's own tape", async () => {
    await readLiveTape([MINT], fakeHelius(), { maxPages: 1, refreshMs: 60_000, nowMs: 0 });
    const scored = (w: string) => (w === RISKY ? { score: 90, dumps: 0, walletScore: 0.4 } : undefined);
    expect(liveBuyersOf(MINT, 1)).toEqual([RISKY]);
    expect(liveWalletScoreOf(MINT, scored, undefined, 1)).toEqual({
      walletScoreRecentBuyersMean: 0.4,
      walletScoreRecentBuyersScored: 1,
    });
    expect(liveWalletScoreOf(MINT, scored, new Set([RISKY]), 1)).toEqual({
      walletScoreRecentBuyersMean: null,
      walletScoreRecentBuyersScored: 0,
    });
    expect(liveWalletScoreOf(MINT, undefined, undefined, 1)).toBeNull();
    expect(liveWalletScoreOf(MINT, scored, undefined, 16 * 60_000)).toBeNull();
  });

  it("scores the page it was handed, whose buyers the own-tape read saw, when a newer page lands after", async () => {
    await readLiveTape([MINT], fakeHelius(), { maxPages: 1, refreshMs: 60_000, nowMs: 0 });
    const scored = (w: string) =>
      w === RISKY || w === OTHER ? { score: 50, dumps: 0, walletScore: 0.4 } : undefined;
    const page = livePageOf(MINT, 1);
    const ownTape = new Set(liveBuyersOn(page));
    // A newer page with a new buyer lands between the own-tape read and the score.
    const later = fakeHelius();
    later.getMintTransactionsPage.mockResolvedValue({
      status: "ok",
      txs: [buyTx(OTHER, 1, 1_700_000_200)],
      paginationToken: null,
    });
    await readLiveTape([MINT], later, { maxPages: 1, refreshMs: 0, nowMs: 2 });
    expect(liveBuyersOf(MINT, 3)).toEqual([OTHER]);
    expect(liveWalletScoreOn(page, scored, ownTape)).toEqual({
      walletScoreRecentBuyersMean: null,
      walletScoreRecentBuyersScored: 0,
    });
    expect(livePageOf(MINT, 16 * 60_000)).toBeUndefined();
  });

  it("reads a coin's 5m order flow off its page, as of when it was read, until it is five minutes old", async () => {
    const readAt = 1_700_000_160_000;
    await readLiveTape([MINT], fakeHelius(), { maxPages: 1, refreshMs: 60_000, nowMs: readAt });
    // The page is the coin's whole history: one 2 SOL buy, a minute before the read.
    expect(liveWindowFlowOf(MINT, readAt + 60_000)).toMatchObject({
      uniqueBuyers5m: 1,
      avgBuySol5m: 2,
      newBuyerShare5m: 1,
      tradesPerMin5m: 1,
    });
    expect(liveWindowFlowOf(MINT, readAt + 6 * 60_000)).toBeNull();
    expect(liveWindowFlowOf("other", readAt)).toBeNull();
  });

  it("reads the launch's bags off a page that is the coin's whole history, with the dev off the profile", async () => {
    const readAt = 1_700_000_160_000;
    await readLiveTape([MINT], fakeHelius(), { maxPages: 1, refreshMs: 60_000, nowMs: readAt });
    // The whole history is one buy by RISKY: the dev when the profile says so, else an early buyer.
    expect(liveLaunchBagsOf(MINT, RISKY, readAt)).toEqual({
      earlyBuyerCount: 0,
      earlyBuyerHoldPct: 0,
      earlyBuyerSoldShare: null,
      devSoldShare: 0,
    });
    const noDev = liveLaunchBagsOf(MINT, undefined, readAt);
    expect(noDev).toMatchObject({ earlyBuyerCount: 1, earlyBuyerSoldShare: 0, devSoldShare: null });
    // 1,000 whole tokens of the 1B supply.
    expect(noDev!.earlyBuyerHoldPct).toBeCloseTo(1e-4, 8);
    // A page with an older page behind it says nothing about the launch; nor does a stale one.
    const partial = {
      gtfaUsable: true,
      getMintTransactionsPage: vi.fn(async () => ({
        status: "ok" as const,
        txs: [buyTx(OTHER, 1, 1_700_000_200)],
        paginationToken: "more" as string | null,
      })),
    };
    await readLiveTape([MINT], partial, { maxPages: 1, refreshMs: 0, nowMs: readAt + 1 });
    expect(liveLaunchBagsOf(MINT, RISKY, readAt + 2)).toBeNull();
    expect(liveLaunchBagsOf("other", RISKY, readAt)).toBeNull();
  });
});
