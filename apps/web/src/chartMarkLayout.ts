/**
 * Where the token chart draws its trade marks (user ask 2026-10-19: better shown and handled):
 * buys hang under the price, sells sit over it, so no mark covers the line or the candles it is
 * about. Marks that would touch stack away from the price, a row per level; past MAX_LEVELS a
 * stack's last mark carries a "+N" for the rest. Pure, so the overlay (chartPlugins.ts) draws what
 * this says and the chart hit-tests the same places.
 */

/** A mark to place: its x on the plot, the price's y, the edge it hangs from, and its radius. */
export interface MarkSpot<T> {
  item: T;
  side: "buy" | "sell";
  x: number;
  /** The price at the trade (the stem's dot). */
  priceY: number;
  /** The candle's low for a buy, its high for a sell (the price itself on the line). */
  edgeY: number;
  r: number;
}

/** A placed mark: its centre, its level away from the price, and the marks folded into it. */
export interface PlacedMark<T> extends MarkSpot<T> {
  y: number;
  level: number;
  more: T[];
}

/** Stacked rows at most, each side; the rest fold into the outermost mark's "+N". */
export const MAX_LEVELS = 3;
/** The gap between the price's edge and the first mark, and between stacked marks (px). */
const EDGE_GAP = 7;
const STACK_GAP = 3;
/** Two marks this close side by side (px, past their radii) share a column. */
const SIDE_GAP = 2;

/**
 * The marks' places: in time order, each side apart, each mark on the first level where it touches
 * no mark already placed; a mark with no free level folds into the mark nearest its outermost
 * place. `pitch` is a level's height (the largest mark's diameter). `gap` scales that pitch and the
 * offset from the price (1 is today's); it does not change a mark's radius. `height` keeps marks
 * on the plot.
 */
export function layoutMarks<T>(
  spots: readonly MarkSpot<T>[],
  pitch: number,
  height: number,
  gap = 1,
): PlacedMark<T>[] {
  const g = gap > 0 && Number.isFinite(gap) ? gap : 1;
  const step = pitch * g;
  const edge = EDGE_GAP * g;
  const stack = STACK_GAP * g;
  const out: PlacedMark<T>[] = [];
  for (const side of ["buy", "sell"] as const) {
    const placed: PlacedMark<T>[] = [];
    const mine = spots.filter((s) => s.side === side).sort((a, b) => a.x - b.x);
    const yAt = (s: MarkSpot<T>, level: number) => {
      const away = edge + step / 2 + level * (step + stack);
      const raw = side === "buy" ? s.edgeY + away : s.edgeY - away;
      // Kept on the plot: a buy at the bottom edge or a sale at the top stays in view.
      return Math.min(Math.max(raw, s.r + 1), Math.max(s.r + 1, height - s.r - 1));
    };
    // The placed marks near x, newest first (they are placed left to right).
    const near = (x: number, r: number) => {
      const hits: PlacedMark<T>[] = [];
      for (let i = placed.length - 1; i >= 0; i--) {
        const p = placed[i]!;
        // Past any mark's reach (pictures are the widest): none further left can touch.
        if (x - p.x > 2 * Math.max(p.r, r) + SIDE_GAP + 8) break;
        hits.push(p);
      }
      return hits;
    };
    for (const s of mine) {
      const around = near(s.x, s.r);
      const clear = (y: number) =>
        around.every((p) => Math.hypot(p.x - s.x, p.y - y) >= p.r + s.r + SIDE_GAP);
      let level = 0;
      while (level < MAX_LEVELS && !clear(yAt(s, level))) level++;
      if (level === MAX_LEVELS) {
        // No room left here: the mark nearest its outermost place counts it.
        const y = yAt(s, MAX_LEVELS - 1);
        const host = around.reduce((a, p) =>
          Math.hypot(p.x - s.x, p.y - y) < Math.hypot(a.x - s.x, a.y - y) ? p : a,
        );
        host.more.push(s.item);
        continue;
      }
      const mark: PlacedMark<T> = { ...s, y: yAt(s, level), level, more: [] };
      placed.push(mark);
      out.push(mark);
    }
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
