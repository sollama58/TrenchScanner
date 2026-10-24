import { describe, expect, it } from "vitest";
import {
  agoLabel,
  agoWords,
  deltaText,
  priceText,
  sparkPath,
  statDelta,
  statText,
  TRENCH_STATS,
  type StatKey,
} from "./marketBar";

const spec = (key: StatKey) => TRENCH_STATS.find((s) => s.key === key)!;

describe("statDelta", () => {
  it("compares runners by their difference in count", () => {
    expect(statDelta(spec("runners"), 12, 9)).toMatchObject({
      unit: "",
      dir: "up",
      tone: "good",
    });
    expect(statDelta(spec("runners"), 12, 9).value).toBe(3);
  });

  it("compares rates in percentage points, and reads a rise in rejections as bad", () => {
    expect(statDelta(spec("hit2xPct"), 20, 25)).toEqual({ value: -5, unit: "pt", dir: "down", tone: "bad" });
    expect(statDelta(spec("rejectedPct"), 75, 70)).toEqual({ value: 5, unit: "pt", dir: "up", tone: "bad" });
    expect(statDelta(spec("rejectedPct"), 65, 70)).toMatchObject({ dir: "down", tone: "good" });
  });

  it("has no direction when a side is unknown, and is flat under the noise floor", () => {
    expect(statDelta(spec("hit4xPct"), null, 3)).toMatchObject({ value: null, dir: null, tone: null });
    expect(statDelta(spec("avgReturnPct"), 4.02, 4)).toMatchObject({ dir: "flat", tone: null });
    expect(statDelta(spec("runners"), 5, 0)).toMatchObject({ value: 5, unit: "", dir: "up", tone: "good" });
  });
});

describe("text", () => {
  it("prints deltas, stats and prices compactly", () => {
    expect(deltaText({ value: -3.44, unit: "pt", dir: "down", tone: "bad" })).toBe("3.4pt");
    expect(deltaText({ value: 3, unit: "", dir: "up", tone: "good" })).toBe("3");
    expect(deltaText({ value: null, unit: "", dir: null, tone: null })).toBe("–");
    expect(statText(spec("runners"), 1234)).toBe("1,234");
    expect(statText(spec("hit10xPct"), 1.234)).toBe("1.2%");
    expect(statText(spec("hit2xPct"), 23.4)).toBe("23%");
    expect(statText(spec("avgReturnPct"), -4.5)).toBe("-4.5%");
    expect(statText(spec("avgReturnPct"), null)).toBe("–");
    expect(priceText(81_569.44)).toBe("$81,569");
    expect(priceText(104.6)).toBe("$104.60");
    expect(priceText(0.004554)).toBe("$0.004554");
    expect(priceText(null)).toBe("–");
  });
});

describe("agoLabel / agoWords", () => {
  it("names hours, days and the week", () => {
    expect([2, 6, 24, 48, 72, 168].map(agoLabel)).toEqual(["2h", "6h", "24h", "48h", "72h", "1w"]);
    expect([2, 24, 48, 72, 168].map(agoWords)).toEqual(["2 hours", "24 hours", "2 days", "3 days", "a week"]);
  });
});

describe("sparkPath", () => {
  it("draws left to right, high values near the top, and breaks at unknowns", () => {
    const p = sparkPath([10, 20, null, 30, 40], 100, 50);
    expect(p.d.match(/M/g)).toHaveLength(2);
    expect(p.d.startsWith("M0.0 45.0L25.0")).toBe(true);
    expect(p.d.endsWith("L100.0 5.0")).toBe(true);
    expect([p.lo, p.hi]).toEqual([10, 40]);
    expect(p.area).toBe("M0.0 45.0L25.0 31.7L25.0 50.0L0.0 50.0ZM75.0 18.3L100.0 5.0L100.0 50.0L75.0 50.0Z");
  });

  it("keeps a lone point visible and a flat line inside the box", () => {
    expect(sparkPath([null, 5, null], 100, 50).d).toBe("M50.0 25.0l0.01 0");
    const flat = sparkPath([3, 3, 3], 100, 50);
    expect(flat.y(3)).toBeGreaterThan(5);
    expect(flat.y(3)).toBeLessThan(45);
  });

  it("puts counts on a zero floor", () => {
    expect(sparkPath([4, 8], 100, 50, true).lo).toBe(0);
  });
});
