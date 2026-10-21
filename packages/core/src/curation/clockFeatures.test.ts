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

  it("keeps a decision cap the anchor already wrote when the scan cap cannot rebuild it", () => {
    const kept = applyClockFeatures({ mcapUsd: 0, freshGapPct: 10, decisionMcapUsd: 50_000 });
    expect(kept.decisionMcapUsd).toBe(50_000);
  });

  it("floors a seconds-old pair at one minute before dividing a per-minute rate", () => {
    // 0.01 minute is the smallest age the scan stores. $60 of volume must not become $6,000 a minute.
    const young = applyClockFeatures({
      pairAgeMinutes: 0.01,
      volume5mUsd: 60,
      priceChange5mPct: 12,
      pathRet15mPct: 6,
      pathSpan15mMin: 0.01,
    });
    expect(young.volPerMin5m).toBe(60);
    expect(young.pxSincePairPerMin).toBe(12);
    expect(young.pathRet15mPerMin).toBe(6);
    // A pair that has lived a minute is divided by its real age.
    expect(applyClockFeatures({ pairAgeMinutes: 3, volume5mUsd: 60 }).volPerMin5m).toBe(20);
  });

  it("uses a stored fresh anchor instead of the scan cap it would otherwise keep", () => {
    // A rule-3 row regraded onto a fresh quote stores that cap on the row. The vector can still
    // hold the scan cap, and clearing the gap would rebuild decisionMcapUsd from it.
    const fresh = applyClockFeatures({ mcapUsd: 10_000, freshGapPct: null, decisionMcapUsd: 10_000 }, 16_000);
    expect(fresh.decisionMcapUsd).toBe(16_000);
    const same = applyClockFeatures({ mcapUsd: 10_000, decisionMcapUsd: 10_000 }, 10_000);
    expect(same.decisionMcapUsd).toBe(10_000);
  });

  it("keeps a stored decision cap when the scan cap and gap would rebuild a different one", () => {
    // Live (buildCandidateFeatures) stores decisionAnchor's cap. The anchor refuses a quote
    // that has a price but no market cap, even when the gap is inside the trusted ratio, and
    // the row keeps the scan cap. The gap is still on the vector. Rebuilding
    // mcap * (1 + gap/100) here would train on $12k for a label graded from $10k.
    const kept = applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 20, decisionMcapUsd: 10_000 });
    expect(kept.decisionMcapUsd).toBe(10_000);
    // A row banked before the column existed still gets the rebuilt cap.
    expect(applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 20 }).decisionMcapUsd).toBeCloseTo(12_000);
  });

  it("trusts a fresh quote at the same ratio the label anchor does", () => {
    expect(applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 400 }).decisionMcapUsd).toBeCloseTo(50_000);
    expect(applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 400.01 }).decisionMcapUsd).toBe(10_000);
    expect(applyClockFeatures({ mcapUsd: 10_000, freshGapPct: -80 }).decisionMcapUsd).toBeCloseTo(2_000);
    expect(applyClockFeatures({ mcapUsd: 10_000, freshGapPct: -80.01 }).decisionMcapUsd).toBe(10_000);
  });

  it("leaves a one-sided Jupiter volume unknown on the both-sides column", () => {
    const one = applyClockFeatures({
      pairAgeMinutes: 5,
      jup5mBuyVolumeUsd: 60,
      jup5mSellVolumeUsd: null,
    });
    // The column deployed models read still treats the missing side as zero.
    expect(one.jupVolPerMin5m).toBe(12);
    expect(one.jupVolPerMin5mKnown).toBeNull();
    const both = applyClockFeatures({
      pairAgeMinutes: 5,
      jup5mBuyVolumeUsd: 40,
      jup5mSellVolumeUsd: 20,
    });
    expect(both.jupVolPerMin5m).toBe(12);
    expect(both.jupVolPerMin5mKnown).toBe(12);
  });

  it("keeps the scan's market cap when the fresh quote is too far to be the anchor", () => {
    const filled = applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 1_000 });
    expect(filled.decisionMcapUsd).toBe(10_000);
    const trusted = applyClockFeatures({ mcapUsd: 10_000, freshGapPct: 25 });
    expect(trusted.decisionMcapUsd).toBeCloseTo(12_500);
  });
});
