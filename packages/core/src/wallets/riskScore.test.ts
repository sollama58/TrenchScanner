import { describe, expect, it } from "vitest";
import {
  coinWalletRisk,
  coinWalletWins,
  isWinnerWallet,
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
      walletRiskFirstBuyersMean: 52.5,
      walletRiskHighSupplyPct: 5,
      knownDumperFirstBuyers: 1,
    });
  });

  it("is unknown where nothing in view is scored or read", () => {
    expect(coinWalletRisk(lookup, { top10Holders: ["x"] })).toEqual({
      walletRiskTop10Max: null,
      walletRiskFirstBuyersMean: null,
      walletRiskHighSupplyPct: null,
      knownDumperFirstBuyers: null,
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
    expect(walletLabels(stats({ dumps: 3, appearances: 3 }), market).dumper).toBe(false);
    expect(walletLabels(stats({ dumps: 4, appearances: 4 }), market).dumper).toBe(true);
    expect(walletLabels(stats({ dumps: 4, appearances: 6 }), market).dumper).toBe(false);
    expect(walletLabels(stats({ dumps: 6, appearances: 8 }), market).dumper).toBe(true);
    expect(walletLabels(stats({ wins: 2, appearances: 2 }), market).winner).toBe(false);
    expect(walletLabels(stats({ wins: 3, appearances: 5 }), market).winner).toBe(true);
    expect(walletLabels(stats({ wins: 3, appearances: 6 }), market).winner).toBe(false);
    expect(walletLabels(stats({ snipes: 2, appearances: 2 }), market).sniper).toBe(false);
    expect(walletLabels(stats({ snipes: 3, appearances: 6 }), market).sniper).toBe(true);
    expect(walletLabels(stats({ snipes: 3, appearances: 7 }), market).sniper).toBe(false);
  });

  it("never shows dumper and winner together: the side further above its market wins", () => {
    // 4 of 5 dumped (0.8 vs 0.45) and 3 of 5 doubled (0.6 vs 0.23): the win side is further out.
    expect(walletLabels(stats({ dumps: 4, wins: 3, appearances: 5 }), market)).toEqual({
      dumper: false,
      winner: true,
      sniper: false,
    });
    // Against a market that doubles as often, the dump side is the stronger claim.
    expect(
      walletLabels(stats({ dumps: 4, wins: 3, appearances: 5 }), { dumpRate: 0.2, winRate: 0.5 }),
    ).toEqual({ dumper: true, winner: false, sniper: false });
  });
});
