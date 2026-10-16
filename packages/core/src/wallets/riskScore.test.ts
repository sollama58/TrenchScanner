import { describe, expect, it } from "vitest";
import {
  coinWalletRisk,
  coinWalletWins,
  isWinnerWallet,
  scorePercentile,
  scoreWithoutCoin,
  walletLabels,
  walletRiskScore,
  walletWinScore,
} from "./riskScore.js";

describe("walletRiskScore", () => {
  const none = { appearances: 0, dumps: 0, fastExits: 0, snipes: 0 };

  it("reads a wallet that dumps at the market's rate as 40", () => {
    // (2 + 1) / (10 + 5) = 0.2, the market's rate.
    expect(walletRiskScore({ ...none, appearances: 10, dumps: 2 }, 0.2)).toBe(40);
  });

  it("doesn't brand a wallet on one bad coin", () => {
    expect(walletRiskScore({ ...none, appearances: 1, dumps: 1 }, 0.2)).toBeCloseTo(66.7, 1);
    expect(walletRiskScore({ ...none, appearances: 20, dumps: 15 }, 0.2)).toBe(80);
  });

  it("adds fast exits and snipes by their share of the wallet's coins", () => {
    const base = walletRiskScore({ ...none, appearances: 10, dumps: 2 }, 0.2);
    expect(walletRiskScore({ appearances: 10, dumps: 2, fastExits: 10, snipes: 5 }, 0.2)).toBe(base + 15);
  });

  it("caps at 100 and survives an empty market", () => {
    expect(walletRiskScore({ appearances: 20, dumps: 20, fastExits: 20, snipes: 20 }, 0.2)).toBe(100);
    expect(walletRiskScore({ ...none, appearances: 3 }, 0)).toBeLessThanOrEqual(100);
  });
});

describe("coinWalletRisk", () => {
  const scores = new Map([
    ["a", { score: 90, dumps: 4, dumper: true }],
    ["b", { score: 30, dumps: 0 }],
    ["c", { score: 75, dumps: 4, dumper: true }],
  ]);
  const lookup = (w: string) => scores.get(w);

  it("reads the top holders and first buyers it can score", () => {
    expect(
      coinWalletRisk(lookup, {
        top10Holders: ["a", "b", "x"],
        topHolderShares: [
          { owner: "a", pct: 5 },
          { owner: "b", pct: 4 },
          { owner: "x", pct: 3 },
        ],
        firstBuyers: new Set(["b", "c", "y"]),
      }),
    ).toEqual({
      walletRiskTop10Max: 90,
      walletRiskScoredTop10: 2,
      walletRiskFirstBuyersMean: 52.5,
      walletRiskHighSupplyPct: 5,
      knownDumperFirstBuyers: 1,
    });
  });

  it("is unknown where nothing in view is scored or read", () => {
    expect(coinWalletRisk(lookup, { top10Holders: ["x"] })).toEqual({
      walletRiskTop10Max: null,
      walletRiskScoredTop10: 0,
      walletRiskFirstBuyersMean: null,
      walletRiskHighSupplyPct: null,
      knownDumperFirstBuyers: null,
    });
    expect(coinWalletRisk(lookup, {}).walletRiskScoredTop10).toBeNull();
  });

  // 2026-10-16 (data-correctness audit): a repeat decision reads the wallets without the coin's
  // own tape, and the max as a percentile of the wallets scored at the time.
  describe("without the coin's own tape", () => {
    const market = 0.2;
    // Dumped on 4 of 10 coins, this one among them: 40 * (5/15) / 0.2 = 66.7.
    const counted = { appearances: 10, dumps: 4, fastExits: 0, snipes: 0 };
    const withCounts = new Map([
      ["a", { score: walletRiskScore(counted, market), ...counted, dumper: true }],
      ["b", { score: 30, dumps: 0, appearances: 2, fastExits: 0, snipes: 0 }],
      ["old", { score: 95, dumps: 9 }],
    ]);
    const lookupCounts = (w: string) => withCounts.get(w);
    const ownTape = new Map([
      ["a", { dumpedIntoStop: true, fastExit: false, launchSniper: false }],
      ["old", { dumpedIntoStop: true, fastExit: false, launchSniper: false }],
    ]);

    it("rebuilds a wallet's score from its counts less the coin's own row", () => {
      const own = { dumpedIntoStop: true, fastExit: true, launchSniper: false };
      expect(scoreWithoutCoin({ score: 0, ...counted, fastExits: 1 }, own, market)).toBe(
        walletRiskScore({ appearances: 9, dumps: 3, fastExits: 0, snipes: 0 }, market),
      );
      // Clamped: a row not yet counted can't take the counts below zero.
      expect(
        scoreWithoutCoin({ score: 0, appearances: 0, dumps: 0, fastExits: 0, snipes: 0 }, own, market),
      ).toBe(walletRiskScore({ appearances: 0, dumps: 0, fastExits: 0, snipes: 0 }, market));
      expect(scoreWithoutCoin({ score: 95, dumps: 9 }, own, market)).toBeNull();
    });

    it("reads the max without the coin's own row, and leaves out what it can't rebuild", () => {
      const r = coinWalletRisk(
        lookupCounts,
        { top10Holders: ["a", "b", "old"], firstBuyers: ["a", "old"] },
        { ownTape, marketDumpRate: market },
      );
      // 40 * (4/14) / 0.2 = 57.1; "old" carries no counts, so it is unknown, not 95.
      expect(r.walletRiskTop10Max).toBeCloseTo(57.1, 1);
      expect(r.walletRiskScoredTop10).toBe(2);
      expect(r.walletRiskFirstBuyersMean).toBeCloseTo(57.1, 1);
      expect(r.knownDumperFirstBuyers).toBe(1);
      // Without the market rate nothing can be rebuilt: the wallets on the tape drop out.
      expect(coinWalletRisk(lookupCounts, { top10Holders: ["a", "b"] }, { ownTape })).toMatchObject({
        walletRiskTop10Max: 30,
        walletRiskScoredTop10: 1,
      });
    });

    it("places the max among the wallets scored at the time", () => {
      const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      expect(scorePercentile(sorted, 55)).toBe(50);
      expect(scorePercentile(sorted, 10)).toBe(0);
      expect(scorePercentile(sorted, 100)).toBe(90);
      expect(scorePercentile(sorted, 101)).toBe(100);
      expect(scorePercentile([], 55)).toBe(0);
      expect(scorePercentile([1, 2, 3], 3)).toBe(66.7);
      const r = coinWalletRisk(
        lookup,
        { top10Holders: ["a", "b"] },
        { rank: (s) => scorePercentile(sorted, s) },
      );
      expect(r.walletRiskTop10Max).toBe(80);
      // The other readings stay on the score's own scale.
      expect(
        coinWalletRisk(lookup, { firstBuyers: ["a"] }, { rank: () => 1 }).walletRiskFirstBuyersMean,
      ).toBe(90);
    });
  });
});

describe("walletWinScore", () => {
  it("reads a wallet that wins at the market's rate as 40, plus early wins by their share", () => {
    // (2 + 1) / (10 + 5) = 0.2, the market's rate; none of its wins were early.
    expect(walletWinScore({ appearances: 10, wins: 2, earlyWins: 0 }, 0.2)).toBe(40);
    // Both wins bought before the call: the full early weight.
    expect(walletWinScore({ appearances: 10, wins: 2, earlyWins: 2 }, 0.2)).toBe(60);
    expect(walletWinScore({ appearances: 10, wins: 2, earlyWins: 1 }, 0.2)).toBe(50);
  });

  it("doesn't crown a wallet on one lucky coin, and caps the win points", () => {
    expect(walletWinScore({ appearances: 1, wins: 1, earlyWins: 0 }, 0.2)).toBeCloseTo(66.7, 1);
    expect(walletWinScore({ appearances: 20, wins: 15, earlyWins: 0 }, 0.2)).toBe(80);
    expect(walletWinScore({ appearances: 20, wins: 20, earlyWins: 20 }, 0.2)).toBe(100);
  });

  it("survives an empty market and a wallet with no wins", () => {
    expect(walletWinScore({ appearances: 3, wins: 0, earlyWins: 0 }, 0)).toBeLessThanOrEqual(100);
    expect(walletWinScore({ appearances: 0, wins: 0, earlyWins: 0 }, 0.2)).toBe(40);
  });
});

describe("coinWalletWins", () => {
  const scores = new Map([
    ["a", { score: 10, dumps: 0, winScore: 85, earlyWins: 3, winner: true }],
    ["b", { score: 30, dumps: 0, winScore: 20, earlyWins: 0 }],
    ["c", { score: 75, dumps: 2, winScore: 50, earlyWins: 2, winner: true }],
    ["old", { score: 50, dumps: 1 }],
  ]);
  const lookup = (w: string) => scores.get(w);

  it("reads the win side of the top holders and first buyers it can score", () => {
    expect(
      coinWalletWins(lookup, {
        top10Holders: ["a", "b", "x"],
        topHolderShares: [
          { owner: "a", pct: 5 },
          { owner: "b", pct: 4 },
          { owner: "x", pct: 3 },
        ],
        firstBuyers: new Set(["b", "c", "y"]),
      }),
    ).toEqual({
      walletWinTop10Max: 85,
      walletWinFirstBuyersMean: 35,
      walletWinHighSupplyPct: 5,
      knownWinnerFirstBuyers: 1,
    });
  });

  it("reads rows scored before the win side existed as zero, and unknown lists as null", () => {
    expect(coinWalletWins(lookup, { top10Holders: ["old"] })).toEqual({
      walletWinTop10Max: 0,
      walletWinFirstBuyersMean: null,
      walletWinHighSupplyPct: null,
      knownWinnerFirstBuyers: null,
    });
    expect(isWinnerWallet(scores.get("old"))).toBe(false);
    expect(isWinnerWallet(scores.get("a"))).toBe(true);
    expect(isWinnerWallet(scores.get("c"))).toBe(true);
    expect(isWinnerWallet(scores.get("b"))).toBe(false);
    expect(isWinnerWallet(undefined)).toBe(false);
  });
});

describe("walletLabels", () => {
  const market = { dumpRate: 0.45, winRate: 0.23 };
  const stats = (o: Partial<Parameters<typeof walletLabels>[0]>) => ({
    appearances: 10,
    dumps: 0,
    wins: 0,
    snipes: 0,
    ...o,
  });

  it("needs both the count and the rate", () => {
    expect(walletLabels(stats({ dumps: 3, appearances: 10 }), market).dumper).toBe(false);
    expect(walletLabels(stats({ dumps: 8, appearances: 10 }), market).dumper).toBe(true);
    expect(walletLabels(stats({ dumps: 7, appearances: 10 }), market).dumper).toBe(false);
    expect(walletLabels(stats({ dumps: 9, appearances: 12 }), market).dumper).toBe(true);
    expect(walletLabels(stats({ wins: 2, appearances: 10 }), market).winner).toBe(false);
    expect(walletLabels(stats({ wins: 6, appearances: 10 }), market).winner).toBe(true);
    expect(walletLabels(stats({ wins: 5, appearances: 10 }), market).winner).toBe(false);
    expect(walletLabels(stats({ snipes: 2, appearances: 10 }), market).sniper).toBe(false);
    expect(walletLabels(stats({ snipes: 5, appearances: 10 }), market).sniper).toBe(true);
    expect(walletLabels(stats({ snipes: 5, appearances: 11 }), market).sniper).toBe(false);
  });

  it("gives no label at all under ten coins on record", () => {
    // Every rate clears its bar; only the coin count is short.
    expect(walletLabels(stats({ dumps: 9, wins: 9, snipes: 9, appearances: 9 }), market)).toEqual({
      dumper: false,
      winner: false,
      sniper: false,
    });
    expect(walletLabels(stats({ dumps: 10, appearances: 10 }), market).dumper).toBe(true);
  });

  it("never shows dumper and winner together: the side further above its market wins", () => {
    // 8 of 10 dumped (0.8 vs 0.45) and 6 of 10 doubled (0.6 vs 0.23): the win side is further out.
    expect(walletLabels(stats({ dumps: 8, wins: 6, appearances: 10 }), market)).toEqual({
      dumper: false,
      winner: true,
      sniper: false,
    });
    // Against a market that doubles as often, the dump side is the stronger claim.
    expect(
      walletLabels(stats({ dumps: 8, wins: 6, appearances: 10 }), { dumpRate: 0.2, winRate: 0.5 }),
    ).toEqual({ dumper: true, winner: false, sniper: false });
  });
});
