import { describe, expect, it } from "vitest";
import { MARK_SCALE, markRadius } from "./walletMarks";
import {
  atLiveEnd,
  layoutMarks,
  LIVE_LAG_MS,
  markAt,
  markBandPx,
  MAX_LEVELS,
  priceScaleTop,
  type MarkSpot,
} from "./chartMarkLayout";

const spot = (item: string, side: "buy" | "sell", x: number, r = 8): MarkSpot<string> => ({
  item,
  side,
  x,
  priceY: 100,
  edgeY: side === "buy" ? 110 : 90,
  r,
});

describe("layoutMarks", () => {
  it("puts buys and sales above the candle they clear", () => {
    const [buy, sell] = layoutMarks([spot("b", "buy", 50), spot("s", "sell", 50)], 20, 400);
    expect(buy!.y + buy!.r).toBeLessThanOrEqual(buy!.edgeY - 12);
    expect(sell!.y + sell!.r).toBeLessThanOrEqual(sell!.edgeY - 12);
    expect(buy!.y).toBeLessThan(buy!.edgeY);
    expect(sell!.y).toBeLessThan(sell!.edgeY);
  });

  it("keeps marks that clear each other on the first level", () => {
    const out = layoutMarks([spot("a", "buy", 10), spot("b", "buy", 40)], 20, 400);
    expect(out.map((p) => p.level)).toEqual([0, 0]);
  });

  it("stacks marks that would touch away from the price, then folds the rest into a +N", () => {
    const spots = ["a", "b", "c", "d", "e"].map((id, i) => spot(id, "buy", 50 + i));
    const out = layoutMarks(spots, 20, 400);
    expect(out.map((p) => p.level)).toEqual([0, 1, 2]);
    // The stack grows upward, away from the candles.
    expect(out[1]!.y).toBeLessThan(out[0]!.y);
    expect(out[MAX_LEVELS - 1]!.more).toEqual(["d", "e"]);
  });

  it("stays above a candle at the bottom of the plot", () => {
    const [p] = layoutMarks([{ ...spot("a", "buy", 50), edgeY: 395 }], 20, 400);
    expect(p!.y + p!.r).toBeLessThanOrEqual(395 - 12);
    expect(p!.y).toBeLessThanOrEqual(400 - 8 - 1);
  });

  it("pulls a stack closer with a small gap and pushes it out with a large one", () => {
    const one = (gap?: number) => layoutMarks([spot("a", "buy", 50)], 20, 400, gap)[0]!;
    const near = one(0.5);
    const mid = one(1);
    const far = one(2);
    const lifted = (p: { y: number; r: number; edgeY: number }) => p.edgeY - (p.y + p.r);
    expect(lifted(near)).toBeLessThan(lifted(mid));
    expect(lifted(mid)).toBeLessThan(lifted(far));
    // The gap moves the stack. It does not change a mark's own radius.
    expect(near.r).toBe(8);
    expect(far.r).toBe(8);
    expect(one().y).toBe(mid.y);
    expect(one(0).y).toBe(mid.y);
    expect(one(-1).y).toBe(mid.y);
    // Same x: the rows stay one level apart, and that gap is pitch + 3px at every distance.
    const stacked = (gap: number) =>
      layoutMarks([spot("a", "buy", 50, 4), spot("b", "buy", 50, 4)], 20, 400, gap);
    for (const gap of [0.5, 1, 2]) expect(stacked(gap).map((p) => p.level)).toEqual([0, 1]);
    const span = (gap: number) => {
      const rows = stacked(gap);
      return rows[0]!.y - rows[1]!.y;
    };
    expect(span(0.5)).toBe(23);
    expect(span(1)).toBe(23);
    expect(span(2)).toBe(23);
  });
});

describe("markAt", () => {
  it("finds the mark under a point, the nearest of several", () => {
    const placed = layoutMarks([spot("a", "buy", 50), spot("b", "buy", 80)], 20, 400);
    expect(markAt(placed, 51, placed[0]!.y)?.item).toBe("a");
    expect(markAt(placed, 79, placed[1]!.y + 2)?.item).toBe("b");
    expect(markAt(placed, 65, 10)).toBeNull();
  });
});

describe("trade bubbles above the series (2026-10-21)", () => {
  // The series top is y=40. A buy's own low is much lower on the plot. The old layout hung that
  // buy under its low, so the bubble sat inside other candles. It has to clear the series instead.
  const band = 40;
  const bottom = (p: { y: number; r: number }) => p.y + p.r;

  it("draws every bubble above the series, including a buy under a low candle", () => {
    const [buy] = layoutMarks([{ ...spot("b", "buy", 40), edgeY: 240, priceY: 200 }], 20, 400, 1, band);
    const [sell] = layoutMarks([spot("s", "sell", 80)], 20, 400, 1, band);
    expect(bottom(buy!)).toBeLessThanOrEqual(band - 12);
    expect(bottom(sell!)).toBeLessThanOrEqual(band - 12);
    expect(buy!.y).toBeLessThan(band);
    expect(sell!.y).toBeLessThan(band);
  });

  it("stacks bubbles that share a time upward, still clear of the candles", () => {
    const out = layoutMarks(
      [spot("buy", "buy", 50, 8), spot("sell", "sell", 51, 8), spot("again", "buy", 50, 8)],
      20,
      400,
      1,
      band,
    );
    expect(out.map((p) => p.level)).toEqual([0, 1, 2]);
    for (const p of out) expect(bottom(p)).toBeLessThanOrEqual(band - 12);
    const ys = out.map((p) => p.y);
    expect(Math.max(...ys)).toBeLessThan(band);
  });

  it("keeps that clearance at small, medium and large without changing the saved default size", () => {
    // Medium is factor 1: the radius the chart drew before the size choice (walletMarks MARK_SCALE).
    expect(MARK_SCALE.m).toBe(1);
    expect(MARK_SCALE.s).toBeLessThan(MARK_SCALE.m);
    expect(MARK_SCALE.l).toBeGreaterThan(MARK_SCALE.m);
    const base = markRadius(2);
    for (const size of ["s", "m", "l"] as const) {
      const r = base * MARK_SCALE[size];
      const [p] = layoutMarks([spot(size, "buy", 30, r)], 26 * MARK_SCALE[size], 400, 1, band);
      expect(p!.r).toBeCloseTo(r);
      expect(bottom(p!)).toBeLessThanOrEqual(band - 12);
    }
  });

  it("reserves a top margin at least as tall as the band on the chart heights we draw", () => {
    for (const [pitch, gap, height] of [
      [26, 1, 320],
      [26 * 1.35, 1.4, 280],
      [26 * 0.75, 0.75, 420],
    ] as const) {
      const bandPx = markBandPx(pitch, gap);
      expect(priceScaleTop(bandPx, height) * height).toBeGreaterThanOrEqual(bandPx - 0.5);
    }
  });
});

describe("atLiveEnd", () => {
  it("puts a live trade read before its candle on the newest candle", () => {
    const out = atLiveEnd([{ t: 500 }, { t: 1_000 }, { t: 1_030 }], 1_000);
    expect(out.map((m) => m.t)).toEqual([500, 999, 999]);
  });

  it("leaves trades alone on a view that ends before now, and ones far past the end", () => {
    const items = [{ t: 2_000 }];
    expect(atLiveEnd(items, null)).toBe(items);
    expect(atLiveEnd([{ t: 1_000 + LIVE_LAG_MS }], 1_000)[0]!.t).toBe(1_000 + LIVE_LAG_MS);
  });
});
