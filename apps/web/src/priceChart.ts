/**
 * The token modal's price chart, the parts that are plain arithmetic (so they are unit-tested in
 * priceChart.test.ts): thinning minute candles into a line's points, and the market-cap axis.
 */

const MINUTE = 60_000;
/** Point spacings the chart picks from, in minutes. */
const POINT_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440];

/** The narrowest spacing that fits `spanMs` into at most `maxPoints` points, in ms. */
export function pointWidthMs(spanMs: number, maxPoints: number): number {
  const need = spanMs / Math.max(1, maxPoints);
  const m = POINT_MINUTES.find((b) => b * MINUTE >= need) ?? POINT_MINUTES[POINT_MINUTES.length - 1]!;
  return m * MINUTE;
}

/** One point of the line: a market cap at a moment. */
export interface Point {
  t: number;
  v: number;
}

/**
 * Minute candles as the line's readings: each close at its minute's end, when that price held.
 * Pump.fun stamps a candle with its minute's start, so a close drawn there runs the line a minute
 * ahead of time: at a call's marker it showed where the price went in the minute after the call.
 */
export function candleCloses(candles: readonly { t: number; c: number }[]): Point[] {
  return candles.map((c) => ({ t: c.t + MINUTE, v: c.c }));
}

/**
 * The line with the call's own price added at its time, so the line meets the baseline at the call
 * marker instead of cutting between two minute closes on either side of it. Left as it is when the
 * call is outside the line's span.
 */
export function withCallPoint(points: readonly Point[], call: Point): Point[] {
  if (points.length < 2 || !(call.v > 0)) return [...points];
  if (call.t < points[0]!.t || call.t > points[points.length - 1]!.t) return [...points];
  const out = points.filter((p) => p.t !== call.t);
  const i = out.findIndex((p) => p.t > call.t);
  out.splice(i < 0 ? out.length : i, 0, { t: call.t, v: call.v });
  return out;
}

/**
 * The closes from `fromMs` on (up to `toMs`, when given), thinned to one point per `widthMs` (aligned to the epoch, so a point
 * keeps its place as new minutes arrive): each point is its slot's last close, at that close's
 * time, so the line ends exactly on the latest reading. A slot whose highest close came before its
 * last keeps that close too, at its own time, so the line's highest point - the chart's Peak - is
 * the highest minute close in view, as the card's Peak is, not the highest last-of-slot close.
 */
export function linePoints(
  closes: readonly Point[],
  fromMs: number,
  widthMs: number,
  toMs = Infinity,
): Point[] {
  const out: Point[] = [];
  let slot = Number.NaN;
  let hi: Point | null = null;
  let last: Point | null = null;
  const flush = () => {
    if (hi !== null && last !== null && hi.t < last.t) out.push(hi);
    if (last !== null) out.push(last);
  };
  for (const p of closes) {
    if (p.t < fromMs || p.t > toMs) continue;
    const s = Math.floor(p.t / widthMs);
    if (s !== slot) {
      flush();
      hi = null;
      slot = s;
    }
    last = { t: p.t, v: p.v };
    if (hi === null || p.v > hi.v) hi = last;
  }
  flush();
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

/** What a flagged wallet is, for its swatch's colour: the coin's creator, a risky one, or linked. */
export type MarkerKind = "dev" | "risky" | "kol" | "winner" | "linked";

/** One minute candle's traded volume: its start, open and close (market cap), and USD volume. */
export interface VolumeCandle {
  t: number;
  o: number;
  c: number;
  vol: number;
}

/** One bar of the volume lane: the minutes it spans, their USD volume, and the move across them. */
export interface VolumeBar {
  from: number;
  to: number;
  usd: number;
  o: number;
  c: number;
}

/**
 * Exported for tests. The candles' volume summed into `n` even slices of [t0, t1], each candle by
 * the middle of its minute; a slice with no candles is null. A slice's open is its first candle's
 * open and its close its last candle's close, so its colour says whether the price rose across it.
 */
export function volumeBars(
  candles: readonly VolumeCandle[],
  t0: number,
  t1: number,
  n: number,
): (VolumeBar | null)[] {
  const span = Math.max(1, t1 - t0);
  const out: (VolumeBar | null)[] = Array.from({ length: n }, () => null);
  for (const k of candles) {
    const mid = k.t + MINUTE / 2;
    if (mid < t0 - MINUTE || mid > t1 + MINUTE / 2) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((mid - t0) / span) * n)));
    const b = out[i];
    if (!b) out[i] = { from: k.t, to: k.t + MINUTE, usd: k.vol, o: k.o, c: k.c };
    else {
      b.usd += k.vol;
      b.to = k.t + MINUTE;
      b.c = k.c;
    }
  }
  return out;
}

/** A scan's count of the buys and sells in the 5 minutes before it. */
export interface ScanFlow {
  t: number;
  buys: number;
  sells: number;
}

/** How far back a scan's buy and sell counts reach. */
export const FLOW_WINDOW_MS = 5 * MINUTE;

/**
 * Exported for tests. The scan whose 5-minute count best covers [from, to]: of the scans whose
 * window reaches into it, the one taken nearest its end. Null when no scan covers it.
 */
export function flowAt(flow: readonly ScanFlow[], from: number, to: number): ScanFlow | null {
  let best: ScanFlow | null = null;
  for (const f of flow) {
    if (f.t <= from || f.t > to + FLOW_WINDOW_MS || f.buys + f.sells <= 0) continue;
    if (!best || Math.abs(f.t - to) < Math.abs(best.t - to)) best = f;
  }
  return best;
}
