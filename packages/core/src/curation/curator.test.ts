import { describe, expect, it } from "vitest";
import { evaluateCandidateHeuristic, HEURISTIC_CURATOR_SOURCE } from "./curator.js";
import type { ScoredToken } from "../types.js";

const MIN_SCORE = 70;

/** A candidate that clears every gate - each test breaks exactly one thing. */
function strongCandidate(overrides: Partial<ScoredToken> = {}): ScoredToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    holderCount: 500,
    holderGrowthPct: 15,
    top10HolderPct: 20,
    devWalletPct: 2,
    riskScore: 20,
    freshTop10WalletPct: 10,
    ageMinutes: 90,
    narrativeTags: ["ai"],
    graduated: true,
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 78 },
    ...overrides,
  };
}

describe("evaluateCandidateHeuristic", () => {
  it("curates a strong candidate with reasons and its score as confidence", () => {
    const decision = evaluateCandidateHeuristic(strongCandidate(), MIN_SCORE);
    expect(decision.curate).toBe(true);
    expect(decision.confidence).toBe(78);
    expect(decision.source).toBe(HEURISTIC_CURATOR_SOURCE);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons.length).toBeLessThanOrEqual(4);
  });

  it("respects the env-tunable score floor", () => {
    expect(evaluateCandidateHeuristic(strongCandidate(), 80).curate).toBe(false);
    expect(evaluateCandidateHeuristic(strongCandidate(), 60).curate).toBe(true);
  });

  it("skips the pool-liquidity floor for a pre-bond token - the bonding curve is the pool", () => {
    const preBond = strongCandidate({ graduated: false, liquidityUsd: undefined });
    expect(evaluateCandidateHeuristic(preBond, MIN_SCORE).curate).toBe(true);
  });

  it.each([
    ["thin liquidity on a graduated token", { liquidityUsd: 5_000 }],
    ["unknown liquidity on a graduated token", { liquidityUsd: undefined }],
    ["unknown venue", { graduated: undefined }],
    ["parked volume", { volumeToMcapRatio: 0.2 }],
    ["unknown volume ratio", { volumeToMcapRatio: undefined }],
    ["sell-side flow", { buys24h: 400, sells24h: 600 }],
    ["no trades at all", { buys24h: 0, sells24h: 0 }],
    ["too young", { ageMinutes: 2 }],
    ["too old", { ageMinutes: 5_000 }],
    ["unknown age", { ageMinutes: undefined }],
  ] as const)("required gate fails closed: %s", (_label, overrides) => {
    expect(evaluateCandidateHeuristic(strongCandidate(overrides), MIN_SCORE).curate).toBe(false);
  });

  it.each([
    ["concentrated top 10", { top10HolderPct: 55 }],
    ["fresh-wallet snipers", { freshTop10WalletPct: 60 }],
    ["risky per RugCheck", { riskScore: 80 }],
    ["heavy dev bag", { devWalletPct: 20 }],
  ] as const)("risk cap vetoes a known-bad profile: %s", (_label, overrides) => {
    expect(evaluateCandidateHeuristic(strongCandidate(overrides), MIN_SCORE).curate).toBe(false);
  });

  it("does NOT veto on risk signals that were never observed", () => {
    const unknownRisk = strongCandidate({
      top10HolderPct: undefined,
      freshTop10WalletPct: undefined,
      riskScore: undefined,
      devWalletPct: undefined,
    });
    expect(evaluateCandidateHeuristic(unknownRisk, MIN_SCORE).curate).toBe(true);
  });
});
