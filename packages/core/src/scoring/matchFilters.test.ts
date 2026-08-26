import { describe, expect, it } from "vitest";
import { matchesFilter } from "./matchFilters.js";
import type { FilterCriteria, ScoredToken } from "../types.js";

function baseToken(overrides: Partial<ScoredToken> = {}): ScoredToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.001,
    marketCapUsd: 200_000,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 70, holderHealth: 70, age: 70, narrative: 70, total: 70 },
    ...overrides,
  };
}

const baseFilter: FilterCriteria = { mcapMin: 50_000, mcapMax: 500_000 };

describe("matchesFilter", () => {
  it("matches a token within the mcap band with no extra criteria", () => {
    expect(matchesFilter(baseToken(), baseFilter)).toBe(true);
  });

  it("rejects a token outside the mcap band", () => {
    expect(matchesFilter(baseToken({ marketCapUsd: 10_000 }), baseFilter)).toBe(false);
    expect(matchesFilter(baseToken({ marketCapUsd: 1_000_000 }), baseFilter)).toBe(false);
  });

  it("applies minVolumeMcapRatio", () => {
    const filter = { ...baseFilter, minVolumeMcapRatio: 1 };
    expect(matchesFilter(baseToken({ volumeToMcapRatio: 0.5 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ volumeToMcapRatio: 1.5 }), filter)).toBe(true);
  });

  it("applies minHolderGrowthPct", () => {
    const filter = { ...baseFilter, minHolderGrowthPct: 10 };
    expect(matchesFilter(baseToken({ holderGrowthPct: 5 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ holderGrowthPct: 20 }), filter)).toBe(true);
  });

  it("applies maxTop10HolderPct only when known", () => {
    const filter = { ...baseFilter, maxTop10HolderPct: 30 };
    expect(matchesFilter(baseToken({ top10HolderPct: 50 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ top10HolderPct: 20 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ top10HolderPct: undefined }), filter)).toBe(true);
  });

  it("applies maxDevWalletPct only when known", () => {
    const filter = { ...baseFilter, maxDevWalletPct: 10 };
    expect(matchesFilter(baseToken({ devWalletPct: 25 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ devWalletPct: 5 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ devWalletPct: undefined }), filter)).toBe(true);
  });

  it("applies maxRiskScore only when known", () => {
    const filter = { ...baseFilter, maxRiskScore: 50 };
    expect(matchesFilter(baseToken({ riskScore: 80 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ riskScore: 20 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ riskScore: undefined }), filter)).toBe(true);
  });

  it("applies excludeCriticalRiskFlags", () => {
    const filter = { ...baseFilter, excludeCriticalRiskFlags: true };
    expect(matchesFilter(baseToken({ riskFlags: ["Creator history of rugged tokens"] }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ riskFlags: ["Creator identity unknown"] }), filter)).toBe(false);
    // A non-critical flag doesn't trip this - only the named critical set does.
    expect(matchesFilter(baseToken({ riskFlags: ["High holder correlation"] }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ riskFlags: [] }), filter)).toBe(true);
  });

  it("does not exclude critical risk flags when the user hasn't opted in", () => {
    expect(matchesFilter(baseToken({ riskFlags: ["Creator history of rugged tokens"] }), baseFilter)).toBe(
      true,
    );
  });

  it("applies maxFreshTop10WalletPct only when known", () => {
    const filter = { ...baseFilter, maxFreshTop10WalletPct: 20 };
    expect(matchesFilter(baseToken({ freshTop10WalletPct: 50 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ freshTop10WalletPct: 10 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ freshTop10WalletPct: undefined }), filter)).toBe(true);
  });

  it("applies min/max token age", () => {
    const filter = { ...baseFilter, minTokenAgeMinutes: 30, maxTokenAgeMinutes: 720 };
    expect(matchesFilter(baseToken({ ageMinutes: 5 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ ageMinutes: 1000 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ ageMinutes: 100 }), filter)).toBe(true);
  });

  it("applies narrative keywords against name/symbol/tags", () => {
    const filter = { ...baseFilter, narrativeKeywords: ["moon"] };
    expect(matchesFilter(baseToken({ name: "Moon Dog" }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ name: "Sun Cat" }), filter)).toBe(false);
  });

  it("applies minScore", () => {
    const filter = { ...baseFilter, minScore: 80 };
    expect(
      matchesFilter(
        baseToken({ score: { momentum: 50, holderHealth: 50, age: 50, narrative: 50, total: 50 } }),
        filter,
      ),
    ).toBe(false);
    expect(
      matchesFilter(
        baseToken({ score: { momentum: 90, holderHealth: 90, age: 90, narrative: 90, total: 90 } }),
        filter,
      ),
    ).toBe(true);
  });
});
