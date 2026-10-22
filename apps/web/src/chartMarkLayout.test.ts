import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "./appearance";
import {
  BUBBLE_GRID_STEPS,
  MARK_SCALE,
  markPrefsOf,
  markRadius,
  walletMarks,
  type MarkSource,
  type WalletMark,
} from "./walletMarks";
import {
  atLiveEnd,
  bubbleItems,
  bubbleMoreCount,
  CHART_GRID_DENSITY,
  CHART_GRID_FONT_PX,
  collapseBubbleSpots,
  gridIntervalAt,
  layoutMarks,
  LIVE_LAG_MS,
  markAt,
  markBandPx,
  MAX_LEVELS,
  OWN_TRADE_BASE,
  OWN_TRADE_CLEARANCE,
  OWN_TRADE_RADIUS,
  ownTradeExtentPx,
  ownTradeRadius,
  ownTradeTop,
  placeOwnTrades,
  priceGridStep,
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

const prefs = markPrefsOf(DEFAULT_APPEARANCE);

/** Marks placed as bubbles. `columnOf` defaults to the x, so one x is one column. */
function bubblesAt(
  sources: readonly MarkSource[],
  xOf: (m: WalletMark, i: number) => number = () => 50,
  columnOf?: (m: WalletMark, i: number) => number,
) {
  const marks = walletMarks(sources, prefs);
  const col = columnOf ?? xOf;
  const spots: MarkSpot<WalletMark>[] = marks.map((m, i) => ({
    item: m,
    side: m.side,
    x: xOf(m, i),
    priceY: 100,
    edgeY: 110,
    r: 8 * MARK_SCALE.m,
    column: col(m, i),
  }));
  return layoutMarks(
    collapseBubbleSpots(spots, (m) => m.bubble ?? null),
    20,
    400,
    1,
    40,
  );
}

const walletsOf = (placed: ReturnType<typeof bubblesAt>) =>
  placed.map((p) => bubbleItems(p).map((m) => m.wallet));

describe("one bubble per KOL, known side and plain side", () => {
  const cupsey: MarkSource = {
    wallet: "K",
    tags: ["kol"],
    kol: "Cupsey",
    trades: [[1_000, 1, 2]],
  };
  const known = (wallet: string): MarkSource => ({
    wallet,
    tags: ["kol"],
    kol: "Cupsey",
    knownSideOf: "K",
    trades: [[1_010, 1, 1]],
  });
  const plain = (wallet: string, kolWallet = "K", kolName = "Cupsey"): MarkSource => ({
    wallet,
    tags: ["side"],
    side: { kind: "probable", kolWallet, kolName },
    trades: [[1_020, 1, 0.8]],
  });

  it("draws a KOL and two side wallets as one bubble and lists all three", () => {
    const placed = bubblesAt([cupsey, known("KS"), plain("S")]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.more).toEqual([]);
    expect(walletsOf(placed)).toEqual([["K", "KS", "S"]]);
    expect(bubbleMoreCount(placed[0]!)).toBe(2);
    expect(placed[0]!.item.wallet).toBe("K");
    expect(placed[0]!.r).toBe(8);
  });

  it("keeps two KOLs as two bubbles, and leaves a side of someone else on its own", () => {
    const other: MarkSource = {
      wallet: "B",
      tags: ["kol"],
      kol: "Other",
      trades: [[1_000, 1, 3]],
    };
    const placed = bubblesAt([
      cupsey,
      plain("SA"),
      other,
      plain("SB", "B", "Other"),
      plain("SX", "Z", "Zed"),
    ]);
    expect(placed).toHaveLength(3);
    expect(walletsOf(placed)).toEqual([["K", "SA"], ["B", "SB"], ["SX"]]);
  });

  it("does not collapse a known-side group into a plain side group", () => {
    const placed = bubblesAt([known("KS1"), known("KS2"), plain("S1"), plain("S2")]);
    expect(placed).toHaveLength(2);
    expect(walletsOf(placed)).toEqual([
      ["KS1", "KS2"],
      ["S1", "S2"],
    ]);
  });

  it("leaves a sale, and the same KOL's buy on the next bar, as their own bubbles", () => {
    const later: MarkSource = {
      ...cupsey,
      trades: [
        [1_000, 1, 2],
        [1_000, -1, 2],
        [2_000, 1, 2],
        [3_000, 1, 2],
        [4_000, 1, 2],
      ],
    };
    const placed = bubblesAt(
      [later, plain("S")],
      (m) => Math.floor(m.t / 1_000) * 4,
      (m) => Math.floor(m.t / 1_000),
    );
    const buys = placed.filter((p) => p.side === "buy" && bubbleItems(p).some((m) => m.wallet === "K"));
    expect(buys).toHaveLength(4);
    expect(walletsOf(buys.filter((p) => p.column === 1))).toEqual([["K", "S"]]);
    expect(placed.filter((p) => p.side === "sell")).toHaveLength(1);
  });

  it("does not join a known side that is stamped with its own wallet", () => {
    const self: MarkSource = {
      wallet: "KS",
      tags: ["kol"],
      kol: "Cupsey",
      knownSideOf: "KS",
      trades: [[1_010, 1, 1]],
    };
    const placed = bubblesAt([cupsey, self]);
    expect(placed.map((p) => p.item.wallet).sort()).toEqual(["K", "KS"]);
  });
});

describe("trade bubbles one grid above the candle", () => {
  // Price p sits at y = 400 - p. A candle high of 100 is y = 300. One grid line is 10 price.
  const toY = (p: number) => 400 - p;
  const bubble = (extra: Partial<MarkSpot<string>> = {}): MarkSpot<string> => ({
    ...spot("k", "buy", 40, 8),
    edgeY: 300,
    priceY: 320,
    hi: 100,
    gridStep: 10,
    ...extra,
  });
  const bottom = (p: { y: number; r: number }) => p.y + p.r;

  it("clears that candle by one grid at small, and 1.5 and 2 at medium and large", () => {
    expect(BUBBLE_GRID_STEPS).toEqual({ s: 1, m: 1.5, l: 2 });
    const place = (steps: number) => layoutMarks([bubble()], 20, 400, 1, 40, { steps, toY })[0]!;
    const small = place(BUBBLE_GRID_STEPS.s);
    const medium = place(BUBBLE_GRID_STEPS.m);
    const large = place(BUBBLE_GRID_STEPS.l);
    expect(bottom(small)).toBeCloseTo(toY(100 + 10 * BUBBLE_GRID_STEPS.s));
    expect(bottom(medium)).toBeCloseTo(toY(100 + 10 * BUBBLE_GRID_STEPS.m));
    expect(bottom(large)).toBeCloseTo(toY(100 + 10 * BUBBLE_GRID_STEPS.l));
    // Not pinned to the series top (y = 40).
    expect(bottom(small)).toBeGreaterThan(40);
    expect(bottom(medium)).toBeLessThan(bottom(small));
    expect(bottom(large)).toBeLessThan(bottom(medium));
    expect(small.r).toBe(8);
  });

  it("uses each candle's high, not one band above the highest wick", () => {
    const out = layoutMarks(
      [bubble({ hi: 50, edgeY: 350, x: 10 }), bubble({ hi: 200, edgeY: 200, x: 80 })],
      20,
      400,
      1,
      40,
      { steps: 1, toY },
    );
    expect(bottom(out[0]!)).toBeCloseTo(toY(60));
    expect(bottom(out[1]!)).toBeCloseTo(toY(210));
    expect(out[0]!.level).toBe(0);
    expect(out[1]!.level).toBe(0);
  });

  it("stacks from that price, not from the overhead band", () => {
    const raw = [bubble({ x: 50 }), bubble({ item: "b", x: 50 }), bubble({ item: "c", x: 51 })];
    const out = layoutMarks(raw, 20, 400, 1, 40, { steps: 1, toY });
    expect(out.map((p) => p.level)).toEqual([0, 1, 2]);
    expect(bottom(out[0]!)).toBeCloseTo(toY(110));
    expect(out[1]!.y).toBeLessThan(out[0]!.y);
    expect(out[2]!.y).toBeLessThan(out[1]!.y);
  });
});

describe("priceGridStep", () => {
  it("matches the chart grid on a market-cap pane", () => {
    expect(priceGridStep(10_000, 80_000, 400)).toBe(5_000);
    expect(priceGridStep(0, 100, 280)).toBe(10);
    expect(priceGridStep(40, 40, 400)).toBe(0);
    expect(priceGridStep(1, 2, 0)).toBe(0);
  });
});

describe("gridIntervalAt", () => {
  const markHeight = Math.ceil(CHART_GRID_FONT_PX * CHART_GRID_DENSITY);
  it("reads one tick of pixels through a log scale, not a linear tick of the floor-to-price range", () => {
    // y falls as log10(price) rises, across 5 decades.
    const toY = (p: number) => 400 * (1 - Math.log10(p) / 5);
    const fromY = (y: number) => 10 ** ((1 - y / 400) * 5);
    const low = gridIntervalAt(1_000, toY, fromY, markHeight);
    const high = gridIntervalAt(10_000, toY, fromY, markHeight);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    expect((1_000 + low) / 1_000).toBeCloseTo((10_000 + high) / 10_000, 5);
    expect(low).not.toBeCloseTo(priceGridStep(1, 1_000, 400), -2);
  });
});

describe("the trader's own triangles on the candle", () => {
  const lowY = 180;
  const own = (item: string, side: "buy" | "sell", x: number) => ({
    item,
    side,
    x,
    lowY,
    priceY: 140,
  });

  it("anchors a buy and a sell just under the candle low, clear of the body", () => {
    const [buy, sell] = placeOwnTrades([own("b", "buy", 40), own("s", "sell", 120)]);
    expect(buy!.r).toBe(OWN_TRADE_RADIUS);
    expect(buy!.r).toBeGreaterThan(8);
    expect(sell!.r).toBe(buy!.r);
    expect(ownTradeTop(buy!.side, buy!.y, buy!.r)).toBeCloseTo(lowY + OWN_TRADE_CLEARANCE);
    expect(ownTradeTop(sell!.side, sell!.y, sell!.r)).toBeCloseTo(lowY + OWN_TRADE_CLEARANCE);
    expect(ownTradeTop(buy!.side, buy!.y, buy!.r)).toBeGreaterThan(lowY);
    expect(buy!.y).toBeGreaterThan(lowY);
    expect(sell!.y).toBeGreaterThan(lowY);
    expect(buy!.y - buy!.r).toBeCloseTo(sell!.y - OWN_TRADE_BASE * sell!.r);
    expect(buy!.y + OWN_TRADE_BASE * buy!.r).toBeCloseTo(sell!.y + sell!.r);
  });

  it("grows only with the mark scale, and stacks a second trade further under the same candle", () => {
    const one = placeOwnTrades([own("a", "buy", 10)])[0]!;
    const large = placeOwnTrades([own("a", "buy", 10)], 1.35)[0]!;
    expect(ownTradeRadius(1)).toBe(10);
    expect(ownTradeRadius(0)).toBe(10);
    expect(one.r).toBe(10);
    expect(large.r).toBeCloseTo(13.5);
    expect(large.r).toBeLessThan(16);
    const stacked = placeOwnTrades([own("a", "buy", 10), own("b", "sell", 12)]);
    expect(stacked.map((p) => p.level)).toEqual([0, 1]);
    expect(stacked[1]!.y).toBeGreaterThan(stacked[0]!.y);
    expect(ownTradeTop(stacked[1]!.side, stacked[1]!.y, stacked[1]!.r)).toBeGreaterThan(lowY);
    const lowest = Math.max(
      ...stacked.map((p) => (p.side === "sell" ? p.y + p.r : p.y + OWN_TRADE_BASE * p.r)),
    );
    expect(ownTradeExtentPx(1)).toBeGreaterThan(lowest - lowY);
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
