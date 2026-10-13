import { describe, expect, it } from "vitest";
import { coinWalletRisk, walletRiskScore } from "./riskScore.js";

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
    ["a", { score: 90, dumps: 4 }],
    ["b", { score: 30, dumps: 0 }],
    ["c", { score: 75, dumps: 2 }],
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
