import { describe, expect, it } from "vitest";
import { buildCandidateFeatures, scoredFromFeatures, CANDIDATE_FEATURE_NAMES } from "./features.js";
import type { ScoredToken } from "../types.js";

function scored(overrides: Partial<ScoredToken> = {}): ScoredToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 80, holderHealth: 70, age: 100, narrative: 40, total: 75 },
    ...overrides,
  };
}

describe("buildCandidateFeatures - short-window derivations", () => {
  it("derives the 1h buy ratio, and nulls it when the hour saw no trades", () => {
    expect(buildCandidateFeatures(scored({ buys1h: 80, sells1h: 20 })).buyRatio1h).toBeCloseTo(0.8);
    expect(buildCandidateFeatures(scored({ buys1h: 0, sells1h: 0 })).buyRatio1h).toBeNull();
    expect(buildCandidateFeatures(scored({})).buyRatio1h).toBeNull();
  });

  it("derives 1h churn against mcap", () => {
    const f = buildCandidateFeatures(scored({ volume1hUsd: 30_000 }));
    expect(f.volume1hToMcapRatio).toBeCloseTo(0.2);
    expect(buildCandidateFeatures(scored({})).volume1hToMcapRatio).toBeNull();
  });

  it("derives volume acceleration as the 5m pace over the 1h actual", () => {
    // 5k in 5 minutes extrapolates to 60k/hour; over an actual 30k hour that's 2x - speeding up.
    const f = buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 30_000 }));
    expect(f.volumeAccel).toBeCloseTo(2);
    // A zero-volume hour has no pace to compare against - null, not Infinity.
    expect(buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 0 })).volumeAccel).toBeNull();
  });

  it("records every declared feature name, unknowns as null", () => {
    const f = buildCandidateFeatures(scored({}));
    for (const name of CANDIDATE_FEATURE_NAMES) {
      expect(f).toHaveProperty(name);
    }
    expect(f.priceChange5mPct).toBeNull();
    expect(f.priceChange1hPct).toBeNull();
  });

  it("passes observed short-window values straight through", () => {
    const f = buildCandidateFeatures(
      scored({ priceChange5mPct: -12, priceChange1hPct: 40, buys1h: 10, sells1h: 5 }),
    );
    expect(f.priceChange5mPct).toBe(-12);
    expect(f.priceChange1hPct).toBe(40);
    expect(f.buys1h).toBe(10);
    expect(f.sells1h).toBe(5);
  });
});

describe("scoredFromFeatures - replay round trip", () => {
  it("reconstructs the fields the heuristic gate reads, short-window included", () => {
    const original = scored({
      buys1h: 80,
      sells1h: 20,
      priceChange5mPct: -30,
      volume1hUsd: 30_000,
      liquidityUsd: 40_000,
      graduated: true,
      ageMinutes: 90,
    });
    const replayed = scoredFromFeatures(
      buildCandidateFeatures(original),
      original.priceUsd,
      original.marketCapUsd,
    );
    expect(replayed.buys1h).toBe(80);
    expect(replayed.sells1h).toBe(20);
    expect(replayed.priceChange5mPct).toBe(-30);
    expect(replayed.volumeToMcapRatio).toBeCloseTo(1.3);
    expect(replayed.graduated).toBe(true);
    expect(replayed.ageMinutes).toBe(90);
  });

  it("rows banked before the short-window capture replay those fields as unknown", () => {
    const legacyFeatures = { volumeToMcapRatio: 1.3, buys24h: 700, sells24h: 300, scoreTotal: 75 };
    const replayed = scoredFromFeatures(legacyFeatures, 0.0001, 150_000);
    expect(replayed.buys1h).toBeUndefined();
    expect(replayed.priceChange5mPct).toBeUndefined();
    // The gate's fallback then judges buy pressure on the 24h window, exactly as it did when
    // the row was banked.
    expect(replayed.buys24h).toBe(700);
  });
});
