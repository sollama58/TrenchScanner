/**
 * The token modal's price chart, the parts that are plain arithmetic (so they are unit-tested in
 * priceChart.test.ts): stitching candles of different widths and the live curve ticks into one
 * line, thinning it into points, and the market-cap and time axes.
 */

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** Point spacings the chart picks from, in ms: seconds for the short views the fine candles fill. */
const POINT_MS = [1, 2, 5, 10, 15, 30]
  .map((s) => s * SECOND)
  .concat([1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440].map((m) => m * MINUTE));

/**
 * The narrowest spacing that fits `spanMs` into at most `maxPoints` points, in ms, and never finer
 * than `minMs` (the finest candles in view: thinner than them adds no detail).
 */
export function pointWidthMs(spanMs: number, maxPoints: number, minMs = MINUTE): number {
  const need = Math.max(minMs, spanMs / Math.max(1, maxPoints));
  return POINT_MS.find((b) => b >= need) ?? POINT_MS[POINT_MS.length - 1]!;
}

/** A run of candles of one width: their closes, as candleCloses gives them, and that width. */
export interface CloseRun {
  points: readonly Point[];
  stepMs: number;
}

/**
 * Exported for tests. The finest reading at every moment: each run (coarse to fine) wins from where
 * it starts, so the minute closes cover what Pump.fun's finer pages don't reach back to, the
 * 15-second ones the hours before the 1-second page, and the live curve ticks everything after the
 * newest candle. A finer run starts at its first candle's start (its first close less its width).
 */
export function stitch(runs: readonly CloseRun[], ticks: readonly Point[] = []): Point[] {
  let out: Point[] = [];
  for (const run of runs) {
    if (run.points.length === 0) continue;
    const from = run.points[0]!.t - run.stepMs;
    out = out.filter((p) => p.t <= from).concat(run.points);
  }
  const last = out.length > 0 ? out[out.length - 1]!.t : -Infinity;
  for (const p of ticks) if (p.t > last) out.push(p);
  return out;
}

/** Time-axis steps, in ms: round seconds, minutes, hours and days. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30]
  .map((s) => s * SECOND)
  .concat([1, 2, 5, 10, 15, 30].map((m) => m * MINUTE))
  .concat([1, 2, 3, 6, 12, 24].map((h) => h * HOUR));

/**
 * Exported for tests. Round times inside [t0, t1] for the time axis, at most `max` of them:
 * on the minute, the quarter hour, the hour - in local time, so 15:00 falls on 15:00 even in a
 * zone 30 minutes off UTC. With `origin` (the First 15m view's launch) they fall on round times
 * since it instead. Returns the ticks and the step.
 */
export function timeTicks(
  t0: number,
  t1: number,
  max: number,
  origin?: number,
): { ticks: number[]; step: number } {
  const span = Math.max(1, t1 - t0);
  const step = TIME_STEPS.find((s) => span / s <= max) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  // The grid's zero: the origin, else UTC midnight moved to local midnight.
  const zero = origin ?? new Date(t0).getTimezoneOffset() * MINUTE;
  const ticks: number[] = [];
  for (let t = zero + Math.ceil((t0 - zero) / step) * step; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

/** "3:05" since an origin: minutes and seconds, or "1:02:05" past an hour. */
export function sinceLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / SECOND));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** One point of the line: a market cap at a moment. */
export interface Point {
  t: number;
  v: number;
}

/**
 * Candles (a minute wide unless `stepMs` says) as the line's readings: each close at its end, when
 * that price held.
 * Pump.fun stamps a candle with its minute's start, so a close drawn there runs the line a minute
 * ahead of time: at a call's marker it showed where the price went in the minute after the call.
 */
export function candleCloses(candles: readonly { t: number; c: number }[], stepMs = MINUTE): Point[] {
  const out: Point[] = [];
  for (const k of candles) {
    const prev = out[out.length - 1];
    // Pump.fun sends only candles with a trade: across a gap the price held, so the line holds it
    // to the next candle's start rather than ramping across the quiet seconds.
    if (stepMs < MINUTE && prev && k.t > prev.t) out.push({ t: k.t, v: prev.v });
    out.push({ t: k.t + stepMs, v: k.c });
  }
  return out;
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

/**
 * The line's value at `t`, between the points either side of it as the line draws it (straight);
 * null outside the line's span.
 */
export function valueAt(points: readonly Point[], t: number): number | null {
  if (points.length === 0 || t < points[0]!.t || t > points[points.length - 1]!.t) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** A time label sized to the view: the clock within a day, with the date past it. */
export function timeLabel(t: number, spanMs: number, seconds = false): string {
  const d = new Date(t);
  if (spanMs > 36 * 3_600_000) {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds && { second: "2-digit" }),
  });
}

/** What a flagged wallet is, for its swatch's colour: the coin's creator, a risky one, or linked. */
export type MarkerKind = "dev" | "risky" | "kol" | "winner" | "linked";

/** One candle's traded volume: its start, open and close (market cap), and USD volume. */
export interface VolumeCandle {
  t: number;
  o: number;
  c: number;
  vol: number;
  /** Its width in ms; a minute when absent (Pump.fun's minute candles). */
  w?: number;
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
 * the middle of its own width (a minute, 15 seconds or one); a slice with no candles is null. A
 * slice's open is its first candle's open and its close its last candle's close, so its colour
 * says whether the price rose across it. Candles of different widths that overlap (the stitched
 * views) count once: a candle starting before the previous one ends is left out.
 */
export function volumeBars(
  candles: readonly VolumeCandle[],
  t0: number,
  t1: number,
  n: number,
): (VolumeBar | null)[] {
  const span = Math.max(1, t1 - t0);
  const out: (VolumeBar | null)[] = Array.from({ length: n }, () => null);
  let covered = -Infinity;
  for (const k of [...candles].sort((a, b) => a.t - b.t)) {
    const w = k.w ?? MINUTE;
    const mid = k.t + w / 2;
    if (mid < t0 - w || mid > t1 + w / 2 || k.t < covered) continue;
    covered = k.t + w;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((mid - t0) / span) * n)));
    const b = out[i];
    if (!b) out[i] = { from: k.t, to: k.t + w, usd: k.vol, o: k.o, c: k.c };
    else {
      b.usd += k.vol;
      b.to = k.t + w;
      b.c = k.c;
    }
  }
  return out;
}

/**
 * Exported for tests. The volume lane's candles for a stitched view: each run's candles from where
 * that run takes over (the same rule as stitch), so a stretch is counted from one width only.
 */
export function stitchVolume(
  runs: readonly { candles: readonly VolumeCandle[]; stepMs: number }[],
): VolumeCandle[] {
  let out: VolumeCandle[] = [];
  for (const run of runs) {
    if (run.candles.length === 0) continue;
    const from = run.candles[0]!.t;
    out = out
      .filter((k) => k.t + (k.w ?? MINUTE) <= from)
      .concat(run.candles.map((k) => ({ ...k, w: run.stepMs })));
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
