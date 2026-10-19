import { describe, expect, it } from "vitest";
import { cutoffPoints, offScale, perHourText, shareAt } from "./cutoffCurve";

const point = (alerts: number) => ({ minProbability: 0.5, alerts, winRatePct: 40, goalRatePct: 20 });

describe("cutoffPoints", () => {
  it("aligns a full curve with the six slices and reads calls an hour off the moment flow", () => {
    const pts = cutoffPoints([1, 2, 5, 10, 20, 50].map(point), 40);
    expect(pts.map((p) => p.sharePct)).toEqual([1, 2, 5, 10, 20, 50]);
    expect(pts[2]!.perHour).toBeCloseTo(2);
    expect(pts[5]!.calls).toBe(50);
  });

  it("aligns a curve missing its thinnest slices from the end", () => {
    const pts = cutoffPoints([5, 10, 20, 50].map(point), null);
    expect(pts.map((p) => p.sharePct)).toEqual([5, 10, 20, 50]);
    expect(pts[0]!.perHour).toBeNull();
  });
});

describe("shareAt", () => {
  it("places shares on a linear axis from 0% to 50% by default, clamped", () => {
    expect(shareAt(0)).toBe(0);
    expect(shareAt(25)).toBeCloseTo(0.5);
    expect(shareAt(10)).toBeCloseTo(0.2);
    expect(shareAt(50)).toBe(1);
    expect(shareAt(80)).toBe(1);
  });

  it("places shares on a log axis from 1% to 50% when asked, clamped", () => {
    expect(shareAt(1, true)).toBe(0);
    expect(shareAt(50, true)).toBe(1);
    expect(shareAt(Math.sqrt(50), true)).toBeCloseTo(0.5);
    expect(shareAt(0.2, true)).toBe(0);
    expect(shareAt(80, true)).toBe(1);
  });
});

describe("perHourText", () => {
  it("keeps a decimal under ten an hour", () => {
    expect(perHourText(2.345)).toBe("2.3/h");
    expect(perHourText(14.6)).toBe("15/h");
    expect(perHourText(null)).toBe("–");
  });
});

describe("offScale", () => {
  it("names the edge a share runs past, so the chart can say so instead of pinning it silently", () => {
    expect(offScale(0.4)).toBe("below");
    expect(offScale(80)).toBe("above");
    expect(offScale(1)).toBeNull();
    expect(offScale(50)).toBeNull();
    expect(offScale(12)).toBeNull();
  });
});
