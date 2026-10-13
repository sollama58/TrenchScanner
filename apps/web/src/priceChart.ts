/**
 * The token modal's price chart, the parts that are plain arithmetic (so they are unit-tested in
 * priceChart.test.ts): grouping minute candles into bars, and the market-cap axis.
 */

/** One bar, priced as market cap. Mirrors apps/api/src/tokenChart.ts McapCandle. */
export interface Bar {
  /** The bar's start, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const MINUTE = 60_000;
/** Bar widths the chart picks from, in minutes. */
const BAR_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440];

/** The narrowest bar width that fits `spanMs` into at most `maxBars` bars, in ms. */
export function barWidthMs(spanMs: number, maxBars: number): number {
  const need = spanMs / Math.max(1, maxBars);
  const m = BAR_MINUTES.find((b) => b * MINUTE >= need) ?? BAR_MINUTES[BAR_MINUTES.length - 1]!;
  return m * MINUTE;
}

/**
 * The candles from `fromMs` on, grouped into bars `widthMs` wide (aligned to the epoch, so a bar
 * keeps its place as new minutes arrive). A bar opens at its first candle's open and closes at its
 * last candle's close; minutes with no trade simply have no candle, as on Pump.fun's own chart.
 */
export function groupBars(candles: readonly Bar[], fromMs: number, widthMs: number): Bar[] {
  const out: Bar[] = [];
  for (const c of candles) {
    if (c.t < fromMs) continue;
    const t = Math.floor(c.t / widthMs) * widthMs;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    } else {
      out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c });
    }
  }
  return out;
}

export interface Axis {
  /** Value to y, in px from the top. */
  y: (v: number) => number;
  /** Labelled values, low to high. */
  ticks: number[];
  log: boolean;
}

/**
 * The market-cap axis over [lo, hi], drawn from `top` to `bottom` px. A coin that moved more than
 * 4x in view gets a log axis, so a run from $8K to $400K doesn't flatten everything before it;
 * ticks then sit on 1, 2 and 5 times a power of ten. A calmer one stays linear on round steps.
 */
export function mcapAxis(lo: number, hi: number, top: number, bottom: number, maxTicks = 5): Axis {
  if (!(lo > 0) || !(hi > 0)) {
    lo = 1;
    hi = 10;
  }
  if (hi <= lo) {
    // A flat line: give it some room either side.
    hi = lo * 1.05;
    lo = lo * 0.95;
  }
  const log = hi / lo > 4;
  if (log) {
    // A little headroom either side, in log terms.
    const pad = (Math.log(hi) - Math.log(lo)) * 0.06;
    const a = Math.log(lo) - pad;
    const b = Math.log(hi) + pad;
    const y = (v: number) => bottom - ((Math.log(Math.max(v, 1e-9)) - a) / (b - a)) * (bottom - top);
    return { y, ticks: logTicks(Math.exp(a), Math.exp(b), maxTicks), log };
  }
  const span = hi - lo;
  const a = lo - span * 0.08;
  const b = hi + span * 0.08;
  const y = (v: number) => bottom - ((v - a) / (b - a)) * (bottom - top);
  return { y, ticks: linearTicks(a, b, maxTicks), log };
}

/** 1-2-5 ticks inside [lo, hi], thinned to at most `max`. */
export function logTicks(lo: number, hi: number, max = 5): number[] {
  const all: number[] = [];
  for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** p;
      if (v >= lo && v <= hi) all.push(v);
    }
  }
  if (all.length <= max) return all;
  const powers = all.filter((v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
  if (powers.length >= 2 && powers.length <= max) return powers;
  const step = Math.ceil(all.length / max);
  return all.filter((_, i) => i % step === 0);
}

/** Round linear ticks inside [lo, hi]: steps of 1, 2, 2.5 or 5 times a power of ten. */
export function linearTicks(lo: number, hi: number, max = 5): number[] {
  const raw = (hi - lo) / Math.max(1, max - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/** A time label sized to the view: the clock within a day, with the date past it. */
export function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs > 36 * 3_600_000) {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What a flagged wallet is, for its marker's colour: the coin's creator, a risky one, or linked. */
export type MarkerKind = "dev" | "risky" | "linked";
export const MARKER_KINDS: readonly MarkerKind[] = ["dev", "risky", "linked"];

/** One flagged wallet's trade, to mark on the chart. */
export interface MarkerTrade {
  t: number;
  side: 1 | -1;
  sol: number | null;
  wallet: string;
  kind: MarkerKind;
}

/** The marked trades of one kind and side inside one bar, drawn as one marker. */
export interface MarkerGroup {
  bar: number;
  kind: MarkerKind;
  side: 1 | -1;
  trades: MarkerTrade[];
  /** SOL across the trades whose amount is known. */
  sol: number;
  wallets: number;
}

/**
 * Exported for tests. The trades grouped onto the bars they fall in: per bar, kind and side, so a
 * busy bot shows one marker a bar rather than a smear. Candles own [t, t + step); a line's
 * readings own the trades nearest them, within a step and a half. Trades off the bars are left out.
 */
export function groupMarkers(
  bars: readonly Bar[],
  stepMs: number,
  mode: "candles" | "line",
  trades: readonly MarkerTrade[],
): MarkerGroup[] {
  if (bars.length === 0) return [];
  const groups = new Map<string, MarkerGroup & { seen: Set<string> }>();
  for (const tr of trades) {
    const i = barAt(bars, tr.t);
    let bar = -1;
    if (mode === "candles") {
      if (i >= 0 && tr.t < bars[i]!.t + stepMs) bar = i;
    } else {
      const near = [i, i + 1].filter((j) => j >= 0 && j < bars.length);
      const best = near.sort((a, b) => Math.abs(bars[a]!.t - tr.t) - Math.abs(bars[b]!.t - tr.t))[0];
      if (best !== undefined && Math.abs(bars[best]!.t - tr.t) <= stepMs * 1.5) bar = best;
    }
    if (bar < 0) continue;
    const key = `${bar}|${tr.kind}|${tr.side}`;
    let g = groups.get(key);
    if (!g) {
      g = { bar, kind: tr.kind, side: tr.side, trades: [], sol: 0, wallets: 0, seen: new Set() };
      groups.set(key, g);
    }
    g.trades.push(tr);
    g.sol += tr.sol ?? 0;
    g.seen.add(tr.wallet);
    g.wallets = g.seen.size;
  }
  return [...groups.values()]
    .map(({ seen: _seen, ...g }) => g)
    .sort((a, b) => a.bar - b.bar || MARKER_KINDS.indexOf(a.kind) - MARKER_KINDS.indexOf(b.kind));
}

/** The last bar starting at or before `t`, or -1. */
function barAt(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
