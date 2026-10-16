import { describe, expect, it } from "vitest";
import { featureOnset, inputFills } from "./featureOnset.js";

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

/**
 * 14 days of decision rows every five minutes (4,000), the row's age cycling through `ages`
 * (minutes; null = unknown). `f` decides each input's value from the row index and its age.
 */
function aged(
  f: (i: number, age: number | null) => Record<string, number | null>,
  ages: readonly (number | null)[] = [2, 10, 40, 120],
) {
  return Array.from({ length: 4000 }, (_, i) => {
    const age = ages[i % ages.length]!;
    return {
      anchorAt: new Date(T0 + i * 5 * 60_000),
      sampleKind: "event",
      features: { ...f(i, age), ageMinutes: age },
    };
  });
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

  it("measures coverage over the exam's span when given one", () => {
    // Present on the newest 120 rows: half of the newest-half reference, but only 36% of the
    // newest 70% the exam sets its cutoffs on.
    const r = rows((i) => ({ x: i >= 360 ? 1 : null }));
    expect(featureOnset(r, ["x"], 0.5).usable).toEqual(["x"]);
    expect(featureOnset(r, ["x"], 0.7).usable).toEqual([]);
  });

  it("keeps a sparse input whose coverage is steady", () => {
    const r = rows((i) => ({ sparse: i % 5 === 0 ? 1 : null }));
    expect(featureOnset(r, ["sparse"]).usable).toEqual(["sparse"]);
  });

  it("holds an input full overall but gone dead on young coins, and keeps one steady by age", () => {
    // 14 days of decision rows every five minutes, ages cycling through the four buckets; every
    // bucket has rows enough on both spans. `holders` is lost on coins under five minutes old in
    // the newest tenth (RugCheck's lag, 2026-10-16): 75% of the newest rows still carry it, so
    // the pooled check alone would admit it. `accel` is never read under five minutes, on every row.
    const r = aged((i, age) => ({
      holders: age !== null && age < 5 && i >= 3600 ? null : 1,
      accel: age !== null && age < 5 ? null : 1,
      steady: 1,
    }));
    const { usable, held } = featureOnset(r, ["holders", "accel", "steady"]);
    expect(usable).toEqual(["accel", "steady"]);
    expect(held).toHaveLength(1);
    expect(held[0]!.feature).toBe("holders");
    expect(held[0]!.recentPct).toBe(75);
    expect(held[0]!.buckets).toEqual([
      { bucket: "age under 5 min", referencePct: 80, recentPct: 0, referenceRows: 500, recentRows: 100 },
    ]);
  });

  it("judges rows of unknown age as their own bucket", () => {
    const r = aged((i, age) => ({ x: age === null && i >= 3600 ? null : 1 }), [2, null]);
    const { held } = featureOnset(r, ["x"]);
    expect(held.map((h) => h.buckets?.map((b) => b.bucket))).toEqual([["age unknown"]]);
  });

  it("reports fill per age bucket for every judged bucket", () => {
    const fills = inputFills(
      aged((_, age) => ({ x: age !== null && age >= 60 ? null : 1 })),
      ["x"],
    );
    expect(fills[0]!.buckets?.map((b) => [b.bucket, b.referencePct, b.recentPct])).toEqual([
      ["age under 5 min", 100, 100],
      ["age 5-20 min", 100, 100],
      ["age 20-60 min", 100, 100],
      ["age 60+ min", 0, 0],
    ]);
  });

  it("judges from the first row on the current label rule, or the window's start when later", () => {
    // 1,000 hourly rows: the first 800 graded under an older rule, the rest current. `quote` is
    // read only on current-rule rows: over the whole window the reference (newest 70%) is 29%
    // filled against a full newest span, which would hold it until the old rows aged out.
    const r = Array.from({ length: 1000 }, (_, i) => ({
      anchorAt: new Date(T0 + i * HOUR),
      sampleKind: "event",
      labelRule: i >= 800 ? 4 : 3,
      features: { quote: i >= 800 ? 1 : null, newer: i >= 950 ? 1 : null },
    }));
    const all = r.map((row) => ({ ...row, labelRule: 4 }));
    expect(featureOnset(all, ["quote"], 0.7).usable).toEqual([]);
    expect(featureOnset(r, ["quote"], 0.7).usable).toEqual(["quote"]);
    // `newer` covers 36% of the current-rule reference: held. A window starting later (at row
    // 900) is where the judged rows start instead, and there it covers 71%.
    expect(featureOnset(r, ["newer"], 0.7).usable).toEqual([]);
    expect(featureOnset(r, ["newer"], 0.7, new Date(T0 + 900 * HOUR)).usable).toEqual(["newer"]);
    // A window starting before the first current-rule row changes nothing.
    expect(featureOnset(r, ["newer"], 0.7, new Date(T0)).usable).toEqual([]);
    expect(inputFills(r, ["quote"], 0.7)[0]!.referencePct).toBe(100);
  });

  it("judges on decision rows when there are enough, and holds nothing back on thin history", () => {
    const hourly = rows((i) => ({ x: i >= 470 ? 1 : null }), "hourly");
    const events = rows(() => ({ x: 1 }));
    expect(featureOnset([...hourly, ...events], ["x"]).usable).toEqual(["x"]);
    expect(featureOnset(hourly.slice(-60), ["x"]).usable).toEqual(["x"]);
  });
});
