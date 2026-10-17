import { describe, expect, it } from "vitest";
import type { ScoredWallet } from "./riskScore.js";
import { isCleanWinner, winnerFollowReading } from "./winnerFollow.js";

const wallet = (over: Partial<ScoredWallet>): ScoredWallet => ({
  score: 40,
  dumps: 0,
  appearances: 20,
  winner: false,
  own2x: 0,
  transferWins: 0,
  ...over,
});

const buy = (w: string, sol = 1) => ({ wallet: w, side: "buy" as const, sol });
const sell = (w: string, sol = 1) => ({ wallet: w, side: "sell" as const, sol });

describe("isCleanWinner", () => {
  it("needs the Winner label and no win fed by tokens transferred in", () => {
    expect(isCleanWinner(wallet({ winner: true }))).toBe(true);
    expect(isCleanWinner(wallet({ winner: true, transferWins: 1 }))).toBe(false);
    expect(isCleanWinner(wallet({ winner: true, transferWins: undefined }))).toBe(false);
    expect(isCleanWinner(wallet({ winner: false }))).toBe(false);
    expect(isCleanWinner(undefined)).toBe(false);
  });
});

describe("winnerFollowReading", () => {
  const book = new Map<string, ScoredWallet>([
    ["W1", wallet({ winner: true, own2x: 9, appearances: 20 })],
    ["W2", wallet({ winner: true, own2x: 4, appearances: 10 })],
    // A Winner whose wins came from tokens sent to it: unknown on every input.
    ["T", wallet({ winner: true, transferWins: 2, own2x: 8, appearances: 12 })],
    // Too few coins for its own-2x record.
    ["N", wallet({ own2x: 3, appearances: 4 })],
    ["P", wallet({ own2x: 0, appearances: 10 })],
  ]);
  const lookup = (w: string) => book.get(w);

  it("counts the clean winners among the distinct buyers, their SOL share and the buyers' own-2x record", () => {
    const r = winnerFollowReading(
      [buy("W1", 2), buy("W1", 1), buy("W2", 1), buy("T", 4), buy("N"), buy("P"), buy("X"), sell("W2", 9)],
      lookup,
    );
    expect(r.recentBuyersRead).toBe(6);
    expect(r.cleanWinnerRecentBuyers).toBe(2);
    expect(r.cleanWinnerRecentShare).toBeCloseTo(2 / 6, 4);
    // W1 3 + W2 1 of 3 + 1 + 4 + 1 + 1 + 1 = 11 SOL bought; sells don't count.
    expect(r.cleanWinnerBuySolShare).toBeCloseTo(4 / 11, 4);
    // (9+1)/(20+10) + (4+1)/(10+10) + (0+1)/(10+10), over six buyers.
    expect(r.recentBuyersOwn2xMean).toBeCloseTo((10 / 30 + 5 / 20 + 1 / 20) / 6, 4);
  });

  it("reads a wallet on the coin's own tape as unknown, still a buyer", () => {
    const r = winnerFollowReading([buy("W1"), buy("W2")], lookup, new Set(["W1"]));
    expect(r.recentBuyersRead).toBe(2);
    expect(r.cleanWinnerRecentBuyers).toBe(1);
    expect(r.cleanWinnerBuySolShare).toBeCloseTo(0.5, 4);
  });

  it("reads tokens sent in from another wallet as no buy: 0 SOL, or a rent-priced buy stored before", () => {
    const r = winnerFollowReading(
      [buy("W1", 0), { ...buy("W2", 0.002), tokens: 5_000_000 }, { ...buy("P", 0.5), tokens: 5_000_000 }],
      lookup,
    );
    expect(r.recentBuyersRead).toBe(1);
    expect(r.cleanWinnerRecentBuyers).toBe(0);
  });

  it("is empty without buyers", () => {
    expect(winnerFollowReading([sell("W1")], lookup)).toEqual({
      cleanWinnerRecentBuyers: 0,
      cleanWinnerRecentShare: null,
      cleanWinnerBuySolShare: null,
      recentBuyersOwn2xMean: null,
      recentBuyersRead: 0,
    });
  });
});
