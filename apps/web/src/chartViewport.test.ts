import { describe, expect, it } from "vitest";
import { chartHistoryGrew, openingLogicalRange, retimeRange } from "./chartViewport";

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

describe("retimeRange", () => {
  const M = 60_000;
  // Chart audit 2026-10-29: switching sizes kept the old size's bar numbers on the new slots.
  it("keeps the moments on screen across a new candle size", () => {
    // Slots from 0, 600 minute bars; the view on bars 100 to 200 (01:40:30 to 03:20:30).
    const was = { start: 0, tfMs: M, n: 600 };
    const now = { start: 0, tfMs: 5 * M, n: 120 };
    const r = retimeRange({ from: 100, to: 200 }, was, now, 600);
    // At 5m the same moments are bars 19.6 to 39.6 (the slot centres shift by half a bar each).
    expect(r.from).toBeCloseTo(19.6);
    expect(r.to).toBeCloseTo(39.6);
  });
  it("keeps a view on the newest bar there, as far past it", () => {
    const was = { start: 0, tfMs: M, n: 600 };
    // The finer slots start later (MAX_SLOTS) and run a little further.
    const now = { start: 300 * M, tfMs: 15_000, n: 1_204 };
    const r = retimeRange({ from: 550, to: 601 }, was, now, 600);
    // The right edge 1.5 minutes past the last minute's end: as far past the last 15s slot's end.
    expect(r.to).toBeCloseTo(1_204 - 0.5 + 6);
    expect(r.to - r.from).toBeCloseTo(51 * 4);
  });
  it("keeps the candles readable: trimmed or widened on the left, the right edge held", () => {
    const was = { start: 0, tfMs: M, n: 600 };
    // Six hours of minutes at 1s is 21,600 bars: at most 300 at 2 px on 600 px.
    const fine = retimeRange({ from: 240, to: 599.5 }, was, { start: 0, tfMs: 1_000, n: 36_000 }, 600);
    expect(fine.to).toBeCloseTo(35_999.5);
    expect(fine.to - fine.from).toBeCloseTo(300);
    // Ten minutes at 4h is a sliver: at least 12.5 bars at 48 px.
    const wide = retimeRange({ from: 590, to: 599.5 }, was, { start: 0, tfMs: 240 * M, n: 3 }, 600);
    expect(wide.to - wide.from).toBeCloseTo(12.5);
  });
  it("keeps the view as it was over the same slots (a rebuild of the series)", () => {
    const f = { start: 1_000, tfMs: M, n: 600 };
    const r = retimeRange({ from: 100, to: 200 }, f, f, 600);
    expect(r.from).toBeCloseTo(100);
    expect(r.to).toBeCloseTo(200);
  });
});
