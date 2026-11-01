import { describe, expect, it } from "vitest";
import {
  walletScore,
  walletScoreMarket,
  walletScoreReading,
  walletScoreV2,
  type WalletScoreCounts,
} from "./walletScore.js";
import type { TapeTrade } from "./tradeTape.js";

const market = walletScoreMarket({
  appearances: 1000,
  earlyBuys: 400,
  early2x: 20,
  early4x: 4,
  own2x: 30,
  own4x: 4,
  fastExits: 700,
  dumps: 420,
});

/** A wallet whose every count is the market's rate. */
const average = (appearances: number, earlyBuys: number): WalletScoreCounts => ({
  appearances,
  earlyBuys,
  early2x: earlyBuys * 0.05,
  early4x: earlyBuys * 0.01,
  own2x: appearances * 0.03,
  own4x: appearances * 0.004,
  fastExits: appearances * 0.7,
  dumps: appearances * 0.42,
});

describe("walletScore", () => {
  it("reads 0 for a wallet like the market, and nothing under three coins", () => {
    expect(walletScore(average(40, 20), market)).toBeCloseTo(0, 6);
    expect(walletScore(average(2, 1), market)).toBeNull();
  });

  it("rises with early runs and own multiples, falls with fast exits and dumps", () => {
    const base = average(20, 10);
    const s0 = walletScore(base, market)!;
    expect(walletScore({ ...base, early2x: 4, early4x: 2 }, market)!).toBeGreaterThan(s0);
    expect(walletScore({ ...base, own2x: 5, own4x: 2 }, market)!).toBeGreaterThan(s0);
    expect(walletScore({ ...base, fastExits: 20 }, market)!).toBeLessThan(s0);
    expect(walletScore({ ...base, dumps: 20 }, market)!).toBeLessThan(s0);
  });

  it("smooths toward the market, so one lucky coin moves a short record less than ten move a long one", () => {
    const short = walletScore({ ...average(3, 3), early2x: 1 }, market)!;
    const long = walletScore({ ...average(30, 30), early2x: 10 }, market)!;
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });

  it("keeps the market's rates to two significant figures, so a small drift moves no score", () => {
    const drifted = walletScoreMarket({
      appearances: 1003,
      earlyBuys: 401,
      early2x: 20,
      early4x: 4,
      own2x: 30,
      own4x: 4,
      fastExits: 702,
      dumps: 421,
    });
    expect(drifted).toEqual(market);
    expect(market.early2x).toBe(0.05);
    expect(walletScoreMarket({ ...average(3, 3), early2x: 1, earlyBuys: 3 }).early2x).toBe(0.33);
  });

  it("leaves out a count the market never shows", () => {
    const thin = walletScoreMarket({ ...average(100, 40), early4x: 0, own4x: 0 });
    expect(Number.isFinite(walletScore(average(10, 5), thin)!)).toBe(true);
  });
});

describe("walletScoreV2", () => {
  const noHold = { medianHoldSec: null, soldCoins: 0 };
  it("reads 0 for a wallet like the market with a market-like hold, and nothing under three coins", () => {
    expect(walletScoreV2(average(40, 20), market, { medianHoldSec: 120, soldCoins: 30 }, 120)).toBeCloseTo(
      0,
      6,
    );
    expect(walletScoreV2(average(2, 1), market, noHold, 120)).toBeNull();
  });

  it("moves less than v1 on two lucky early coins, and about as much on fast exits", () => {
    const base = average(10, 10);
    const lucky = { ...base, early2x: 2 };
    expect(walletScoreV2(lucky, market, noHold, null)!).toBeGreaterThan(0);
    expect(walletScoreV2(lucky, market, noHold, null)!).toBeLessThan(walletScore(lucky, market)! / 2);
    const flipper = { ...base, fastExits: 10 };
    expect(walletScoreV2(flipper, market, noHold, null)!).toBeLessThan(0);
    expect(
      Math.abs(walletScoreV2(flipper, market, noHold, null)! - walletScore(flipper, market)!),
    ).toBeLessThan(0.1);
  });

  it("raises the score for longer holds and lowers it for shorter, weighted by the coins sold, clipped", () => {
    const base = average(20, 10);
    const s0 = walletScoreV2(base, market, noHold, 120)!;
    const long = walletScoreV2(base, market, { medianHoldSec: 600, soldCoins: 20 }, 120)!;
    const short = walletScoreV2(base, market, { medianHoldSec: 20, soldCoins: 20 }, 120)!;
    expect(long).toBeGreaterThan(s0);
    expect(short).toBeLessThan(s0);
    // Few coins sold: the same hold moves the score less.
    expect(walletScoreV2(base, market, { medianHoldSec: 600, soldCoins: 2 }, 120)!).toBeLessThan(long);
    // Clipped: a day-long hold reads as 2, not 6.
    expect(walletScoreV2(base, market, { medianHoldSec: 86_400, soldCoins: 1000 }, 120)!).toBeCloseTo(
      0.5 * 2 * (1000 / 1005),
      3,
    );
    // No market hold yet: the term is left out.
    expect(walletScoreV2(base, market, { medianHoldSec: 600, soldCoins: 20 }, null)!).toBeCloseTo(s0, 6);
  });
});

describe("walletScoreReading", () => {
  const trade = (wallet: string, side: "buy" | "sell"): TapeTrade => ({
    wallet,
    side,
    sol: 1,
    tokens: 1,
    atMs: 0,
    tx: `${wallet}-${side}-${Math.random()}`,
  });
  const scores: Record<string, number | null> = { a: 1, b: -1, c: 3, d: null };

  it("averages each buyer once, skipping sellers, unscored wallets and the coin's own tape", () => {
    const trades = [
      trade("a", "buy"),
      trade("a", "buy"),
      trade("b", "buy"),
      trade("c", "sell"),
      trade("d", "buy"),
    ];
    expect(walletScoreReading(trades, (w) => scores[w])).toEqual({
      walletScoreRecentBuyersMean: 0,
      walletScoreRecentBuyersScored: 2,
    });
    expect(walletScoreReading(trades, (w) => scores[w], new Set(["b"]))).toEqual({
      walletScoreRecentBuyersMean: 1,
      walletScoreRecentBuyersScored: 1,
    });
  });

  it("is unknown when no buyer has a score", () => {
    expect(walletScoreReading([trade("d", "buy")], (w) => scores[w])).toEqual({
      walletScoreRecentBuyersMean: null,
      walletScoreRecentBuyersScored: 0,
    });
  });
});
