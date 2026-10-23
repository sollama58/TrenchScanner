import { describe, expect, it } from "vitest";
import { deltaText, priceText, statDelta, statText, TRENCH_STATS, type StatKey } from "./marketBar";

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
