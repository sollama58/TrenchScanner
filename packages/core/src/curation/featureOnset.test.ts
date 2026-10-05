import { describe, expect, it } from "vitest";
import { featureOnset } from "./featureOnset.js";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const HOUR = 3_600_000;

/** 20 days of hourly decision rows; `f` decides each input's value from the row's hour index. */
function rows(f: (i: number) => Record<string, number | null>, kind: string = "event") {
  return Array.from({ length: 480 }, (_, i) => ({
    anchorAt: new Date(T0 + i * HOUR),
    sampleKind: kind,
    features: f(i),
  }));
}

describe("featureOnset", () => {
  it("holds back an input wired in the last hours and keeps a steady one", () => {
    const r = rows((i) => ({ steady: i, fresh: i >= 478 ? 1 : null, newer: i >= 470 ? 1 : null }));
    const { usable, held } = featureOnset(r, ["steady", "fresh", "newer"]);
    expect(usable).toEqual(["steady"]);
    expect(held.map((h) => h.feature)).toEqual(["fresh", "newer"]);
    expect(held[1]!.recentPct).toBeGreaterThan(held[1]!.referencePct);
  });

  it("lets an input in once it covers enough of the reference span", () => {
    // The reference is the newest half (240 rows); present on the newest 120 of them = 50%.
    const r = rows((i) => ({ x: i >= 360 ? 1 : null }));
    expect(featureOnset(r, ["x"]).usable).toEqual(["x"]);
    // Present on the newest 60 = 25% of the reference: still held.
    const early = rows((i) => ({ x: i >= 420 ? 1 : null }));
    expect(featureOnset(early, ["x"]).usable).toEqual([]);
  });

  it("holds back an input that went dead lately, and one that is never there", () => {
    const r = rows((i) => ({ dead: i < 430 ? 1 : null, never: null }));
    expect(featureOnset(r, ["dead", "never"]).usable).toEqual([]);
  });

  it("keeps a sparse input whose coverage is steady", () => {
    const r = rows((i) => ({ sparse: i % 5 === 0 ? 1 : null }));
    expect(featureOnset(r, ["sparse"]).usable).toEqual(["sparse"]);
  });

  it("judges on decision rows when there are enough, and holds nothing back on thin history", () => {
    const hourly = rows((i) => ({ x: i >= 470 ? 1 : null }), "hourly");
    const events = rows(() => ({ x: 1 }));
    expect(featureOnset([...hourly, ...events], ["x"]).usable).toEqual(["x"]);
    expect(featureOnset(hourly.slice(-60), ["x"]).usable).toEqual(["x"]);
  });
});
