import { describe, expect, it } from "vitest";
import { scoreToken } from "./scorer.js";
import type { EnrichedToken } from "../types.js";

function baseToken(overrides: Partial<EnrichedToken> = {}): EnrichedToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.001,
    marketCapUsd: 200_000,
    narrativeTags: [],
    ...overrides,
  };
}

describe("scoreToken", () => {
  it("scores a strong candidate highly", () => {
    const token = baseToken({
      volume24hUsd: 500_000,
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
    const score = scoreToken(token);
    expect(score.total).toBeGreaterThan(80);
  });

  it("scores a weak candidate low", () => {
    const token = baseToken({
      volumeToMcapRatio: 0,
      buys24h: 5,
      sells24h: 50,
      holderGrowthPct: -10,
      top10HolderPct: 58,
      ageMinutes: 5,
      narrativeTags: [],
    });
    const score = scoreToken(token);
    expect(score.total).toBeLessThan(30);
  });

  it("stays within 0-100 bounds", () => {
    const token = baseToken({ volumeToMcapRatio: 999, buys24h: 1000, sells24h: 0 });
    const score = scoreToken(token);
    for (const value of Object.values(score)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("treats unknown age as neutral, not punishing", () => {
    const known = scoreToken(baseToken({ ageMinutes: 60 }));
    const unknown = scoreToken(baseToken({ ageMinutes: undefined }));
    expect(unknown.age).toBe(50);
    expect(known.age).toBeGreaterThan(unknown.age);
  });
});
