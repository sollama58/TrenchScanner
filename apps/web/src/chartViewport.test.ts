import { describe, expect, it } from "vitest";
import { chartHistoryGrew, openingLogicalRange } from "./chartViewport";

describe("openingLogicalRange", () => {
  const extent = { t0: 0, t1: 60 * 60_000 };

  it("includes history before now on first open, not only the last few bars", () => {
    const n = 120;
    const plotW = 640;
    const tfMs = 60_000;
    const { from, to } = openingLogicalRange(n, plotW, tfMs, extent);
    expect(to).toBe(n - 0.5);
    // openingSpanMs is at least five minutes at one-minute candles: more than the old ~8-bar default.
    expect(to - from).toBeGreaterThan(8);
    expect(from).toBeLessThan(n - 8);
  });

  it("shows the whole series when it is shorter than the opening span", () => {
    const { from, to } = openingLogicalRange(6, 640, 60_000, extent);
    expect(from).toBe(-0.5);
    expect(to).toBe(5.5);
  });
});

describe("chartHistoryGrew", () => {
  it("is true when the view's start moves earlier", () => {
    expect(chartHistoryGrew(10 * 60_000, 2 * 60_000, 30_000)).toBe(true);
    expect(chartHistoryGrew(10 * 60_000, 9.8 * 60_000, 30_000)).toBe(false);
  });
});
