/**
 * Where the token chart draws its trade marks (user ask 2026-10-21: the bubbles sat on the
 * candles and hid them). Letter and picture bubbles sit a few of the chart's horizontal grid
 * intervals above their own candle high, in price, so a small distance is one grid mark and a
 * larger one is only a little higher. They are not parked in a band above the highest wick.
 * The signed-in trader's triangles sit just under that candle's low. Marks that share a column
 * still stack upward. Pure, so the overlay (chartPlugins.ts) draws what this says and the chart
 * hit-tests the same places.
 *
 * Marks that do not carry a price-space lift still clear the series band (the layout the chart
 * used before the grid offset). The chart's trade bubbles do not use that path.
 */

/**
 * Who a trade bubble belongs to (walletMarks.ts stamps this from the wallet's role). A KOL, that
 * KOL's known sides, and that KOL's plain sides share an `id` (the KOL's wallet) and differ by
 * `role`, so two KOLs stay apart and a side is not drawn on a KOL it is not tied to.
 */
export interface BubbleIdentity {
  role: "kol" | "known" | "side";
  id: string;
}

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
   * is higher, so a bubble cannot sit inside a neighbouring candle. Price-space bubbles ignore
   * that series top and use `hi` instead.
   */
  edgeY: number;
  r: number;
  /**
   * Other trades drawn as this same bubble (a KOL with its side wallets). The detail lists them.
   * They do not add another bubble.
   */
  grouped?: T[];
  /**
   * Candle high in price, when this bubble's bottom should clear it by `gridStep` lines
   * (letter and picture bubbles).
   */
  hi?: number;
  /** One horizontal grid line, in price units, at this candle. */
  gridStep?: number;
  /**
   * The bar this trade sits on. Wallets group only when they share a column. Neighbouring bars
   * stay apart, even when a zoomed-out chart draws them a few pixels apart.
   */
  column?: number;
}

/** A placed mark: its centre, its level away from the price, and the marks folded into it. */
export interface PlacedMark<T> extends MarkSpot<T> {
  y: number;
  level: number;
  /** Trades folded in because the column already has MAX_LEVELS bubbles. Drawn as "+N". */
  more: T[];
  /** Trades drawn as this bubble. The detail lists `item` and these. */
  grouped: T[];
}

/** Stacked rows at most; the rest fold into the outermost mark's "+N". */
export const MAX_LEVELS = 3;
/**
 * How far a bubble's bottom edge sits above the series, before the distance selector (px).
 * Used only for marks that have no price-space lift. Trade bubbles use the grid instead.
 */
const SERIES_CLEARANCE = 18;
/** The closest the distance selector may pull a bubble to the series (px). */
export const MIN_SERIES_CLEARANCE = 12;
/** Fixed space between stacked marks on one column (px). The distance selector does not scale it. */
const STACK_GAP = 3;
/** Two marks this close side by side (px, past their radii) share a column. */
const SIDE_GAP = 2;
/** Extra px past the radii before two marks are too far apart to share a column. */
const COLUMN_SLACK = 8;

/**
 * Room kept above the marker band for the chart's event flags (px). priceScaleTop adds this
 * to the band so the flags and the bubbles are not the same row.
 */
export const MARK_FLAG_PX = 28;

/** True when two marks are close enough on x that a pixel column would hold both. */
export function sameBubbleColumn(a: { x: number; r: number }, b: { x: number; r: number }): boolean {
  return Math.abs(a.x - b.x) <= 2 * Math.max(a.r, b.r) + SIDE_GAP + COLUMN_SLACK;
}

/**
 * One column id per spot. A caller-supplied `column` (the bar) wins: two trades on the same bar
 * share it, and the next bar does not, however close the pixels are. Without one, a column is an
 * anchor plus the marks within one stack of that anchor. A chain of nearby marks does not grow
 * into a single column across the chart.
 */
function columnIds<T>(spots: readonly MarkSpot<T>[]): number[] {
  if (spots.every((s) => s.column != null && Number.isFinite(s.column))) {
    return spots.map((s) => s.column as number);
  }
  const order = spots.map((s, i) => ({ i, s })).sort((a, b) => a.s.x - b.s.x || a.i - b.i);
  const ids = new Array<number>(spots.length);
  let col = 0;
  let anchor: { x: number; r: number } | null = null;
  for (const o of order) {
    if (!anchor || !sameBubbleColumn(anchor, o.s)) {
      col += 1;
      anchor = o.s;
    }
    ids[o.i] = col;
  }
  return ids;
}

/**
 * One bubble per identity in a column (user ask 2026-10-21: a KOL and that KOL's side wallets were
 * a stack of bubbles on the same trades). `identityOf` reads the wallet role already on the mark.
 * In one column, a KOL and the known sides and plain sides tied to that same id draw as the KOL's
 * bubble. With no KOL in the column, that KOL's known sides are one bubble and its plain sides are
 * another. Two KOLs stay two bubbles. A side whose id is a different wallet stays its own bubble.
 * A buy and a sale stay apart. The next bar is the next column, so consecutive buys do not fold
 * into the earliest trade. Trades with no identity (the reader's own, DexScreener, a dev) are
 * never merged. The returned spot's `grouped` list is what the detail shows besides the bubble.
 */
export function collapseBubbleSpots<T>(
  spots: readonly MarkSpot<T>[],
  identityOf: (item: T) => BubbleIdentity | null,
): MarkSpot<T>[] {
  const columns = columnIds(spots);
  const rows = spots.map((spot, i) => ({
    spot,
    i,
    id: identityOf(spot.item),
    column: columns[i] ?? i,
    key: "",
  }));
  const kolInColumn = (row: (typeof rows)[number], id: string) =>
    rows.some(
      (o) =>
        o.id?.role === "kol" && o.id.id === id && o.spot.side === row.spot.side && o.column === row.column,
    );
  for (const row of rows) {
    const id = row.id;
    if (!id) {
      row.key = `solo:${row.i}`;
      continue;
    }
    const role = (id.role === "known" || id.role === "side") && kolInColumn(row, id.id) ? "kol" : id.role;
    row.key = `${role}:${row.spot.side}:${id.id}:${row.column}`;
  }
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = groups.get(row.key);
    if (list) list.push(row);
    else groups.set(row.key, [row]);
  }
  const out: { i: number; spot: MarkSpot<T> }[] = [];
  for (const group of groups.values()) {
    const primary = group.find((r) => r.id?.role === "kol") ?? group[0]!;
    const grouped = group.filter((r) => r !== primary).map((r) => r.spot.item);
    out.push({
      i: primary.i,
      spot: grouped.length > 0 ? { ...primary.spot, grouped } : primary.spot,
    });
  }
  out.sort((a, b) => a.i - b.i);
  return out.map((o) => o.spot);
}

/** The trades one bubble stands for: its own, the identity group drawn with it, and a "+N" fold. */
export function bubbleItems<T>(p: PlacedMark<T>): T[] {
  return [p.item, ...p.grouped, ...p.more];
}

/** How many other trades the on-canvas "+N" counts: the identity group and a stack that ran out of rows. */
export function bubbleMoreCount<T>(p: PlacedMark<T>): number {
  return p.grouped.length + p.more.length;
}

/** How far a bubble's bottom sits above the series at this distance factor (px). */
export function seriesClearance(gap = 1): number {
  const g = gap > 0 && Number.isFinite(gap) ? gap : 1;
  return Math.max(MIN_SERIES_CLEARANCE, SERIES_CLEARANCE * g);
}

/**
 * Pixels from the series top to the top of a second stacked mark: the first bubble, its
 * clearance, and one more row. `pitch` is a level's height (the largest mark's diameter at
 * the reader's size). Kept for callers that still measure the series band.
 */
export function markBandPx(pitch: number, gap = 1): number {
  const p = pitch > 0 && Number.isFinite(pitch) ? pitch : 0;
  return seriesClearance(gap) + p + (p + STACK_GAP);
}

/**
 * The price scale's top margin (a fraction of the plot) so the series starts below the marker
 * band. Capped so a short chart keeps most of its height for candles.
 */
export function priceScaleTop(bandPx: number, plotHeight: number): number {
  const h = Math.max(160, plotHeight > 0 && Number.isFinite(plotHeight) ? plotHeight : 160);
  const need = Math.max(0, bandPx) + MARK_FLAG_PX;
  return Math.min(0.4, Math.max(0.16, need / h));
}

/**
 * Headroom above the highest price so the top candle's bubble (large distance) and the event
 * flags fit. This is not a band that every bubble is pinned to.
 */
export function bubbleHeadroomPx(steps = 2, markScale = 1, maxRadius = 13): number {
  const s = markScale > 0 && Number.isFinite(markScale) ? markScale : 1;
  const n = steps > 0 && Number.isFinite(steps) ? steps : 2;
  const gridPx = Math.ceil(CHART_GRID_FONT_PX * CHART_GRID_DENSITY);
  const r = maxRadius > 0 && Number.isFinite(maxRadius) ? maxRadius : 13;
  return MARK_FLAG_PX + n * gridPx + r * s;
}

/**
 * The chart's horizontal grid interval, in price, on a linear scale. Same span lightweight-charts
 * 5.2 draws (PriceTickMarkBuilder: three divider orders, the smallest span). `low` and `high`
 * are the prices at the pane edges, `plotHeight` is the pane height in CSS px. Font size 11 and
 * tick density 2.5 match the token chart; minMove 1 matches its price format.
 */
export const CHART_GRID_FONT_PX = 11;
export const CHART_GRID_DENSITY = 2.5;
const TICK_EPS = 1e-14;

function greaterOrEqual(a: number, b: number, epsilon: number): boolean {
  return b - a <= epsilon;
}

function isBaseDecimal(value: number): boolean {
  if (value < 0) return false;
  if (value > 1e18) return true;
  for (let current = value; current > 1; current /= 10) {
    if (current % 10 !== 0) return false;
  }
  return true;
}

function fractionalDividers(base: number): number[] {
  if (isBaseDecimal(base)) return [2, 2.5, 2];
  const out: number[] = [];
  for (let baseRest = base; baseRest !== 1;) {
    if (baseRest % 2 === 0) {
      out.push(2);
      baseRest /= 2;
    } else if (baseRest % 5 === 0) {
      out.push(2, 2.5);
      baseRest /= 5;
    } else break;
    if (out.length > 100) break;
  }
  return out;
}

function tickSpan(
  high: number,
  low: number,
  maxTickSpan: number,
  base: number,
  dividers: readonly number[],
  floorAtOne: boolean,
): number {
  const minMovement = base === 0 ? 0 : 1 / base;
  const span = high - low;
  if (!(span > 0) || !(maxTickSpan > 0)) return 0;
  let resultTickSpan = Math.pow(10, Math.max(floorAtOne ? 0 : -12, Math.ceil(Math.log10(span))));
  let index = 0;
  let c = dividers[0] ?? 2;
  while (true) {
    const aboveMin =
      greaterOrEqual(resultTickSpan, minMovement, TICK_EPS) && resultTickSpan > minMovement + TICK_EPS;
    const aboveMax = greaterOrEqual(resultTickSpan, maxTickSpan * c, TICK_EPS);
    const aboveOne = !floorAtOne || greaterOrEqual(resultTickSpan, 1, TICK_EPS);
    if (!(aboveMin && aboveMax && aboveOne)) break;
    resultTickSpan /= c;
    c = dividers[++index % dividers.length] ?? 2;
  }
  if (resultTickSpan <= minMovement + TICK_EPS) resultTickSpan = minMovement;
  if (floorAtOne) resultTickSpan = Math.max(1, resultTickSpan);
  const fractional = fractionalDividers(base);
  if (fractional.length > 0 && Math.abs(resultTickSpan - 1) < TICK_EPS) {
    index = 0;
    c = fractional[0] ?? 2;
    while (
      greaterOrEqual(resultTickSpan, maxTickSpan * c, TICK_EPS) &&
      resultTickSpan > minMovement + TICK_EPS
    ) {
      resultTickSpan /= c;
      c = fractional[++index % fractional.length] ?? 2;
    }
  }
  return resultTickSpan;
}

export function priceGridStep(
  low: number,
  high: number,
  plotHeight: number,
  opts?: { fontSize?: number; density?: number; minMove?: number },
): number {
  if (!(high > low) || !(plotHeight > 1)) return 0;
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(plotHeight)) return 0;
  const fontSize = opts?.fontSize && opts.fontSize > 0 ? opts.fontSize : CHART_GRID_FONT_PX;
  const density = opts?.density && opts.density > 0 ? opts.density : CHART_GRID_DENSITY;
  const minMove = opts?.minMove && opts.minMove > 0 ? opts.minMove : 1;
  const base = Math.round(1 / minMove);
  const markHeight = Math.ceil(fontSize * density);
  const maxTickSpan = ((high - low) * markHeight) / plotHeight;
  const spans = [
    tickSpan(high, low, maxTickSpan, base, [2, 2.5, 2], true),
    tickSpan(high, low, maxTickSpan, base, [2, 2, 2.5], true),
    tickSpan(high, low, maxTickSpan, base, [2.5, 2, 2], true),
  ].filter((n) => n > 0);
  return spans.length > 0 ? Math.min(...spans) : 0;
}

/**
 * One grid interval in price at `price`, measured through the chart's own scale. `toY` and
 * `fromY` are that scale (priceToCoordinate / coordinateToPrice). On a log scale a pixel step
 * is not a linear tick of the pane, and it is not a linear tick of the range from the floor
 * up to this candle. The step is one tick-mark of pixels at this price.
 */
export function gridIntervalAt(
  price: number,
  toY: (p: number) => number | null,
  fromY: (y: number) => number | null,
  markHeight = Math.ceil(CHART_GRID_FONT_PX * CHART_GRID_DENSITY),
): number {
  if (!(price > 0) || !Number.isFinite(price) || !(markHeight > 0)) return 0;
  const y = toY(price);
  if (y == null || !Number.isFinite(y)) return 0;
  const above = fromY(y - markHeight);
  if (above == null || !Number.isFinite(above) || !(above > price)) return 0;
  return above - price;
}

/** A price-space lift: `steps` grid lines, mapped through the chart's price scale. */
export interface BubblePriceLift {
  steps: number;
  toY: (price: number) => number | null;
}

/**
 * The marks' places, in time order. Marks that carry `hi` and `gridStep` sit `steps` grid lines
 * above that candle's high, in price, and stack upward from there. They are not laid out in the
 * overhead band and then moved. Marks without that lift clear the higher of `seriesTop` and
 * their own candle high. Marks that would touch share a column and stack upward; past
 * MAX_LEVELS the outermost mark carries a "+N". `pitch` is a level's height. `gap` scales only
 * the series-band clearance.
 */
export function layoutMarks<T>(
  spots: readonly MarkSpot<T>[],
  pitch: number,
  height: number,
  gap = 1,
  seriesTop?: number,
  price?: BubblePriceLift,
): PlacedMark<T>[] {
  const g = gap > 0 && Number.isFinite(gap) ? gap : 1;
  const clear = seriesClearance(g);
  const row = (pitch > 0 && Number.isFinite(pitch) ? pitch : 0) + STACK_GAP;
  const top = seriesTop !== undefined && Number.isFinite(seriesTop) ? seriesTop : null;
  const steps = price && price.steps > 0 && Number.isFinite(price.steps) ? price.steps : 1;
  const ceilingOf = (s: MarkSpot<T>) => {
    const edge = Number.isFinite(s.edgeY) ? s.edgeY : s.priceY;
    return top === null ? edge : Math.min(edge, top);
  };
  const yAt = (s: MarkSpot<T>, level: number) => {
    if (price && s.hi != null && s.hi > 0 && s.gridStep != null && s.gridStep > 0) {
      const yUp = price.toY(s.hi + s.gridStep * steps);
      const edge = Number.isFinite(s.edgeY) ? s.edgeY : s.priceY;
      if (yUp != null && Number.isFinite(yUp) && yUp < edge) return yUp - s.r - level * row;
    }
    const ceiling = ceilingOf(s);
    const y = ceiling - (clear + s.r + level * row);
    // A stack that runs past the top of the plot stays there. Pulling it down so it stays
    // inside the plot is what sat bubbles on the candles (2026-10-21).
    if (y > height && ceiling > height) return height - s.r - 1;
    return y;
  };
  const out: PlacedMark<T>[] = [];
  const placed: PlacedMark<T>[] = [];
  // One band for buys and sales. Left to right; equal x keeps the caller's order.
  const mine = spots.map((s, i) => ({ s, i })).sort((a, b) => a.s.x - b.s.x || a.i - b.i);
  const near = (x: number, r: number, column: number | undefined) => {
    const hits: PlacedMark<T>[] = [];
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]!;
      if (x - p.x > 2 * Math.max(p.r, r) + SIDE_GAP + COLUMN_SLACK) break;
      // A neighbouring bar is not this column, even when the zoom draws it a few pixels away.
      if (column != null && p.column != null && p.column !== column) continue;
      hits.push(p);
    }
    return hits;
  };
  for (const { s } of mine) {
    const around = near(s.x, s.r, s.column);
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
      if (host) {
        host.more.push(s.item);
        if (s.grouped?.length) host.grouped.push(...s.grouped);
      }
      continue;
    }
    const mark: PlacedMark<T> = { ...s, y: yAt(s, level), level, more: [], grouped: [...(s.grouped ?? [])] };
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

/**
 * The signed-in trader's own trade triangle (user ask 2026-10-21: they were lifted into the
 * bubble band and looked detached). These sit on the candle, just under its low, in price
 * space. They are not laid out with the KOL, side, or DexScreener bubbles.
 *
 * The radius was 8px. 10px is a modest step up, still scaled by the chart's mark size.
 * `OWN_TRADE_BASE` is how far the blunt edge sits from the centre, in radii: a buy points up
 * (tip at `y - r`, base at `y + OWN_TRADE_BASE * r`) and a sell points down.
 */
export const OWN_TRADE_RADIUS = 10;
export const OWN_TRADE_BASE = 0.7;
/** Pixels between the candle low and the top of the triangle, so the body stays clear. */
export const OWN_TRADE_CLEARANCE = 2;
/** Fixed pixels between two of the trader's own triangles that share a candle. */
const OWN_TRADE_STACK = 2;

/** The triangle's radius at the chart's mark scale (1 is the size drawn today). */
export function ownTradeRadius(scale = 1): number {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  return OWN_TRADE_RADIUS * s;
}

/** Plot y of the triangle's top edge. A buy's tip is the top; a sell's base is the top. */
export function ownTradeTop(side: "buy" | "sell", y: number, r: number): number {
  return side === "buy" ? y - r : y - OWN_TRADE_BASE * r;
}

/**
 * How far below a candle low the bottom margin must reach so one triangle is not clipped.
 * A buy's tip is the top; the base is `OWN_TRADE_BASE` radii below the centre.
 */
export function ownTradeExtentPx(scale = 1): number {
  const r = ownTradeRadius(scale);
  const one = OWN_TRADE_CLEARANCE + r + OWN_TRADE_BASE * r;
  // A second triangle on the same candle stacks this far below the first.
  const step = 2 * r + (1 - OWN_TRADE_BASE) * r + OWN_TRADE_STACK;
  return Math.ceil(one + step + 4);
}

/** One of the trader's own trades, already in plot pixels. `lowY` is the candle low. */
export interface OwnTradeSpot<T> {
  item: T;
  side: "buy" | "sell";
  x: number;
  lowY: number;
  priceY: number;
}

/** A placed own-trade triangle: its centre, and any further trades folded into it. */
export interface PlacedOwnTrade<T> extends OwnTradeSpot<T> {
  y: number;
  r: number;
  level: number;
  more: T[];
}

/**
 * Centres for the signed-in trader's triangles. Each one starts `OWN_TRADE_CLEARANCE` px
 * under its candle low, so it sits on that candle and does not cover the body. Buys and
 * sells share that anchor and stay distinct by which way they point. Several on one candle
 * stack further down; past MAX_LEVELS the lowest one counts the rest. `scale` is the chart's
 * mark size. This does not move the overhead bubble band.
 */
export function placeOwnTrades<T>(spots: readonly OwnTradeSpot<T>[], scale = 1): PlacedOwnTrade<T>[] {
  const r = ownTradeRadius(scale);
  // A buy's centre is `r` below its top; a sell's is `OWN_TRADE_BASE * r` below its top.
  // The step covers that difference, so a sell under a buy (or the reverse) clears the row above.
  const step = 2 * r + (1 - OWN_TRADE_BASE) * r + OWN_TRADE_STACK;
  const yAt = (s: OwnTradeSpot<T>, level: number) => {
    const top = s.lowY + OWN_TRADE_CLEARANCE + level * step;
    return s.side === "buy" ? top + r : top + OWN_TRADE_BASE * r;
  };
  const placed: PlacedOwnTrade<T>[] = [];
  const out: PlacedOwnTrade<T>[] = [];
  for (const s of spots) {
    const around = placed.filter((p) => Math.abs(p.x - s.x) <= p.r + r + 8);
    const clearOf = (y: number) => around.every((p) => Math.hypot(p.x - s.x, p.y - y) >= p.r + r + 2);
    let level = 0;
    while (level < MAX_LEVELS && !clearOf(yAt(s, level))) level++;
    if (level === MAX_LEVELS) {
      const y = yAt(s, MAX_LEVELS - 1);
      const host = around.reduce<PlacedOwnTrade<T> | null>(
        (a, p) => (!a || Math.hypot(p.x - s.x, p.y - y) < Math.hypot(a.x - s.x, a.y - y) ? p : a),
        null,
      );
      if (host) host.more.push(s.item);
      continue;
    }
    const mark: PlacedOwnTrade<T> = { ...s, y: yAt(s, level), r, level, more: [] };
    placed.push(mark);
    out.push(mark);
  }
  return out;
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
