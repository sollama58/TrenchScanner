import { describe, expect, it } from "vitest";
import { applyClockFeatures } from "./clockFeatures.js";

describe("applyClockFeatures", () => {
  it("fills the clock block on a row that was stored before the block existed", () => {
    const stored = {
      pairAgeMinutes: 3,
      volume5mUsd: 3_000,
      volume24hUsd: 3_000,
      buys24h: 30,
      sells24h: null,
      priceChange5mPct: 15,
      priceChange1hPct: 15,
      priceChange6hPct: null,
      priceChange24hPct: 15,
      mcapUsd: 10_000,
      freshGapPct: 5,
      ageMinutes: 3,
      ageSource: 1,
      minutesSinceFirstInBand: 3,
      pathRet15mPct: 8,
      pathSpan15mMin: null,
    };
    const filled = applyClockFeatures(stored);
    expect(filled).not.toBe(stored);
    expect(filled.volPerMin5m).toBeCloseTo(1_000);
    expect(filled.volPerMin24h).toBeCloseTo(1_000);
    expect(filled.tradesPerMin24h).toBeCloseTo(10);
    expect(filled.px5mFullPct).toBeNull();
    expect(filled.pxSincePairPct).toBe(15);
    expect(filled.pxSincePairPerMin).toBeCloseTo(5);
    expect(filled.decisionMcapUsd).toBeCloseTo(10_500);
    expect(filled.launchAgeMinutes).toBe(3);
    expect(filled.bandDwellShare).toBe(1);
    // No span was stored, so the per-minute path return stays unknown.
    expect(filled.pathRet15mPerMin).toBeNull();
    expect(filled.pathSpan15mMin).toBeNull();
    // The inputs the block is built from are left as they were.
    expect(filled.priceChange1hPct).toBe(15);
    expect(filled.volume24hUsd).toBe(3_000);
  });

  it("returns the same object when the block is already what the inputs say", () => {
    const once = applyClockFeatures({
      pairAgeMinutes: 120,
      volume24hUsd: 12_000,
      priceChange5mPct: 2,
      priceChange1hPct: 4,
      priceChange6hPct: 9,
      priceChange24hPct: 9,
      mcapUsd: 50_000,
      ageSource: 0,
      ageMinutes: 400,
      pathRet30mPct: 10,
      pathSpan30mMin: 30,
    });
    expect(applyClockFeatures(once)).toBe(once);
    expect(once.px5mFullPct).toBe(2);
    expect(once.px1hFullPct).toBe(4);
    expect(once.pxSincePairPct).toBe(9);
    expect(once.launchAgeMinutes).toBeNull();
    expect(once.decisionMcapUsd).toBe(50_000);
    expect(once.pathRet30mPerMin).toBeCloseTo(10 / 30);
  });

  it("keeps the scan's market cap when the fresh quote is too far to be the anchor", () => {
    const filled = applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 1_000 });
    expect(filled.decisionMcapUsd).toBe(10_000);
    const trusted = applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 25 });
    expect(trusted.decisionMcapUsd).toBeCloseTo(12_500);
  });
});
