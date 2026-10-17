import { describe, expect, it } from "vitest";
import { axisLabels } from "./FeedReturns";

describe("the week chart's axis labels", () => {
  it("names each local midnight once, on the 6-hour bucket that holds it", () => {
    // 28 six-hour buckets from a local 18:00, so midnight falls in every fourth.
    const start = new Date(2026, 9, 5, 18).getTime();
    const ats = Array.from({ length: 28 }, (_, i) => new Date(start + i * 6 * 3_600_000).toISOString());
    const labels = axisLabels(ats, 360);
    const at = labels.flatMap((l, i) => (l ? [i] : []));
    expect(at).toEqual([1, 5, 9, 13, 17, 21, 25]);
    expect(labels[1]).toBe(new Date(2026, 9, 6).toLocaleDateString(undefined, { weekday: "short" }));
    expect(new Set(at.map((v, i) => v - (at[i - 1] ?? v - 4))).size).toBe(1);
  });

  it("spaces clock times evenly inside a day", () => {
    const ats = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 5, i)).toISOString());
    expect(axisLabels(ats, 60).filter(Boolean)).toHaveLength(6);
  });
});
