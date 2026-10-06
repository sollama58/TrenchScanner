import { describe, expect, it } from "vitest";
import { NARRATIVE_NEUTRAL, scoreToken, scoreTokenLegacy } from "./scorer.js";
import type { EnrichedToken } from "../types.js";
import { EMPTY_TRADE_FLOW } from "../curation/tradeFlow.js";

function baseToken(overrides: Partial<EnrichedToken> = {}): EnrichedToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.001,
    marketCapUsd: 20_000,
    narrativeTags: [],
    ...overrides,
  };
}

describe("scoreToken", () => {
  it("scores a fresh launch with a hot 5-minute window highly", () => {
    const score = scoreToken(
      baseToken({
        ageMinutes: 2,
        graduated: false,
        priceChange5mPct: 60,
        volume5mUsd: 25_000,
        buys5m: 300,
        sells5m: 100,
        top10HolderPct: 25,
        emptyTop10WalletPct: 10,
        tradeFlow: { ...EMPTY_TRADE_FLOW, firstBuyersHolding: 20 },
      }),
    );
    expect(score.total).toBeGreaterThan(85);
  });

  it("scores an old, fading token low", () => {
    const score = scoreToken(
      baseToken({
        ageMinutes: 3000,
        graduated: true,
        priceChange5mPct: -8,
        volume5mUsd: 200,
        buys5m: 10,
        sells5m: 30,
        emptyTop10WalletPct: 60,
      }),
    );
    expect(score.total).toBeLessThan(25);
  });

  it("ranks younger above older, all else equal", () => {
    const young = scoreToken(baseToken({ ageMinutes: 3 }));
    const old = scoreToken(baseToken({ ageMinutes: 120 }));
    expect(young.total).toBeGreaterThan(old.total);
    expect(young.age).toBe(100);
  });

  it("zeroes holder quality for a pre-bond launch with a thin top 10", () => {
    expect(scoreToken(baseToken({ graduated: false, top10HolderPct: 12 })).holderHealth).toBe(0);
    expect(scoreToken(baseToken({ graduated: true, top10HolderPct: 12 })).holderHealth).toBe(50);
    expect(scoreToken(baseToken({ graduated: false, top10HolderPct: 25 })).holderHealth).toBe(50);
  });

  it("lets unknown momentum pieces abstain instead of counting as zero", () => {
    expect(scoreToken(baseToken()).momentum).toBe(50);
    // Only the price move known: it alone sets the part.
    expect(scoreToken(baseToken({ priceChange5mPct: 40 })).momentum).toBe(100);
    // 5m buys missing, falls back to the hour's.
    expect(scoreToken(baseToken({ buys1h: 75, sells1h: 25 })).momentum).toBe(100);
  });

  it("holds narrative neutral until TokenSage feeds it", () => {
    const tagged = scoreToken(baseToken({ narrativeTags: ["dog"], hasTwitter: true, hasWebsite: true }));
    expect(tagged.narrative).toBe(NARRATIVE_NEUTRAL);
    expect(tagged.total).toBe(scoreToken(baseToken()).total);
  });

  it("stays within 0-100 bounds", () => {
    const score = scoreToken(
      baseToken({ priceChange5mPct: 5000, volume5mUsd: 1e9, holderGrowth10mPct: 9999, ageMinutes: 0 }),
    );
    for (const value of Object.values(score)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe("scoreTokenLegacy", () => {
  it("keeps the first composite's numbers for the stored model inputs", () => {
    const token = baseToken({
      volumeToMcapRatio: 2.5,
      buys24h: 800,
      sells24h: 200,
      holderGrowthPct: 25,
      top10HolderPct: 15,
      ageMinutes: 120,
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      narrativeTags: ["dog"],
    });
    const score = scoreTokenLegacy(token);
    expect(score.momentum).toBe(92);
    expect(score.holderHealth).toBe(87.5);
    expect(score.age).toBe(100);
    expect(score.narrative).toBe(100);
    expect(score.total).toBeCloseTo(92 * 0.35 + 87.5 * 0.3 + 15 + 20, 6);
    expect(scoreTokenLegacy(baseToken({ ageMinutes: undefined })).age).toBe(50);
  });
});
