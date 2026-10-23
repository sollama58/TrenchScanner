import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveBuyersOf,
  liveBuyersOn,
  liveFlagsOf,
  livePageOf,
  liveWalletScoreOf,
  liveWalletScoreOn,
  liveWindowFlowOf,
  readLiveTape,
  resetLiveTape,
  takeLiveTapeStats,
} from "./liveTape.js";

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
});
