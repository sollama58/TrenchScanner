/**
 * Where the token chart draws its trade marks (user ask 2026-10-21: the bubbles sat on the
 * candles and hid them). Every mark, a buy or a sale, is drawn in one band above the series,
 * clear of the highest candle it could cover, so the candles stay readable at small, medium
 * and large. Marks that share a time stack upward, away from the candles. The band stays on
 * the plot, just above the series, rather than in a distant margin: the chart reserves a top
 * margin of about this band (priceScaleTop) and the first row sits one clearance above the
 * series top. Pure, so the overlay (chartPlugins.ts) draws what this says and the chart
 * hit-tests the same places.
 */

/** A mark to place: its x on the plot, the price's y, the candle high it must clear, and its radius. */
export interface MarkSpot<T> {
  item: T;
  side: "buy" | "sell";
  x: number;
  /** The price at the trade (the stem's dot). */
  priceY: number;
  /**
   * The candle high at this mark (smaller y is higher on the plot). The line chart passes the
   * price. Buys and sells both clear it; a series-wide top passed to layoutMarks wins when it
   * is higher, so a bubble cannot sit inside a neighbouring candle.
   */
  edgeY: number;
  r: number;
}

/** A placed mark: its centre, its level away from the price, and the marks folded into it. */
export interface PlacedMark<T> extends MarkSpot<T> {
  y: number;
  level: number;
  more: T[];
}

/** Stacked rows at most; the rest fold into the outermost mark's "+N". */
export const MAX_LEVELS = 3;
/**
 * How far a bubble's bottom edge sits above the series, before the distance selector (px).
 * 2026-10-21: the old 7px offset left the bubble on the wick, and buys hung under the low
 * where they covered other candles. 18px clears the wick at medium; the distance selector
 * scales it, and it never drops under MIN_SERIES_CLEARANCE.
 */
const SERIES_CLEARANCE = 18;
/** The closest the distance selector may pull a bubble to the series (px). */
export const MIN_SERIES_CLEARANCE = 12;
/** Fixed space between stacked marks on one column (px). The distance selector does not scale it. */
const STACK_GAP = 3;
/** Two marks this close side by side (px, past their radii) share a column. */
const SIDE_GAP = 2;
/**
 * Room kept above the marker band for the chart's event flags (px). priceScaleTop adds this
 * to the band so the flags and the bubbles are not the same row.
 */
export const MARK_FLAG_PX = 28;

/** How far a bubble's bottom sits above the series at this distance factor (px). */
export function seriesClearance(gap = 1): number {
  const g = gap > 0 && Number.isFinite(gap) ? gap : 1;
  return Math.max(MIN_SERIES_CLEARANCE, SERIES_CLEARANCE * g);
}

/**
 * Pixels from the series top to the top of a second stacked mark: the first bubble, its
 * clearance, and one more row. `pitch` is a level's height (the largest mark's diameter at
 * the reader's size). The chart's top margin is at least this, so the band fits above the
 * candles at small, medium and large.
 */
export function markBandPx(pitch: number, gap = 1): number {
  const p = pitch > 0 && Number.isFinite(pitch) ? pitch : 0;
  return seriesClearance(gap) + p + (p + STACK_GAP);
}

/**
 * The price scale's top margin (a fraction of the plot) so the series starts below the marker
 * band. Capped so a short chart keeps most of its height for candles; the layout still refuses
 * to pull a bubble down onto a candle when the margin is tight.
 */
export function priceScaleTop(bandPx: number, plotHeight: number): number {
  const h = Math.max(160, plotHeight > 0 && Number.isFinite(plotHeight) ? plotHeight : 160);
  const need = Math.max(0, bandPx) + MARK_FLAG_PX;
  return Math.min(0.4, Math.max(0.16, need / h));
}

/**
 * The marks' places, in time order. `seriesTop` is the y of the highest candle in view
 * (smaller y is higher). Every mark clears the higher of that and its own candle high, so a
 * buy is not hung under its low. Marks that would touch share a column and stack upward;
 * past MAX_LEVELS the outermost mark carries a "+N". `pitch` is a level's height (the largest
 * mark's diameter). `gap` scales the clearance off the series (1 is medium); the gap between
 * marks that share a column stays `pitch + STACK_GAP` and a mark's radius is unchanged.
 */
export function layoutMarks<T>(
  spots: readonly MarkSpot<T>[],
  pitch: number,
  height: number,
  gap = 1,
  seriesTop?: number,
): PlacedMark<T>[] {
  const g = gap > 0 && Number.isFinite(gap) ? gap : 1;
  const clear = seriesClearance(g);
  const row = (pitch > 0 && Number.isFinite(pitch) ? pitch : 0) + STACK_GAP;
  const top = seriesTop !== undefined && Number.isFinite(seriesTop) ? seriesTop : null;
  const ceilingOf = (s: MarkSpot<T>) => {
    const edge = Number.isFinite(s.edgeY) ? s.edgeY : s.priceY;
    return top === null ? edge : Math.min(edge, top);
  };
  const out: PlacedMark<T>[] = [];
  const placed: PlacedMark<T>[] = [];
  // One band for buys and sales. Left to right; equal x keeps the caller's order, so the
  // trader's own marks (pushed first) take the row nearest the candles.
  const mine = spots.map((s, i) => ({ s, i })).sort((a, b) => a.s.x - b.s.x || a.i - b.i);
  const yAt = (s: MarkSpot<T>, level: number) => {
    const ceiling = ceilingOf(s);
    const y = ceiling - (clear + s.r + level * row);
    // A stack that runs past the top of the plot stays there. Pulling it down so it stays
    // inside the plot is what sat bubbles on the candles (2026-10-21). The chart's top
    // margin (priceScaleTop) is what keeps the first rows on the plot. `height` only catches
    // a ceiling that is itself below the plot.
    if (y > height && ceiling > height) return height - s.r - 1;
    return y;
  };
  const near = (x: number, r: number) => {
    const hits: PlacedMark<T>[] = [];
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]!;
      if (x - p.x > 2 * Math.max(p.r, r) + SIDE_GAP + 8) break;
      hits.push(p);
    }
    return hits;
  };
  for (const { s } of mine) {
    const around = near(s.x, s.r);
    const clearOf = (y: number) =>
      around.every((p) => Math.hypot(p.x - s.x, p.y - y) >= p.r + s.r + SIDE_GAP);
    let level = 0;
    while (level < MAX_LEVELS && !clearOf(yAt(s, level))) level++;
    if (level === MAX_LEVELS) {
      const y = yAt(s, MAX_LEVELS - 1);
      const host =
        around.length > 0
          ? around.reduce((a, p) => (Math.hypot(p.x - s.x, p.y - y) < Math.hypot(a.x - s.x, a.y - y) ? p : a))
          : placed[placed.length - 1];
      if (host) host.more.push(s.item);
      continue;
    }
    const mark: PlacedMark<T> = { ...s, y: yAt(s, level), level, more: [] };
    placed.push(mark);
    out.push(mark);
  }
  return out;
}

/** The placed mark under a point (px), the nearest when several are. */
export function markAt<T>(
  placed: readonly PlacedMark<T>[],
  x: number,
  y: number,
  slop = 3,
): PlacedMark<T> | null {
  let best: PlacedMark<T> | null = null;
  let bestD = Infinity;
  for (const p of placed) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= p.r + slop && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** How far past the newest candle a live trade may be and still sit on it (the candles' lag). */
export const LIVE_LAG_MS = 5 * 60_000;

/**
 * Trades as a live chart places them: one after the newest candle's end (read live before the
 * candles caught up) sits at that end, so it shows on the newest candle instead of off the plot.
 * `end` null (a view that ends before now) leaves them as they are.
 */
export function atLiveEnd<T extends { t: number }>(items: readonly T[], end: number | null): T[] {
  if (end === null || !items.some((m) => m.t >= end)) return items as T[];
  return items.map((m) => (m.t >= end && m.t < end + LIVE_LAG_MS ? { ...m, t: end - 1 } : m));
}
