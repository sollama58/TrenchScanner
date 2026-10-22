/**
 * The token modal's price chart, the parts that are plain arithmetic (so they are unit-tested in
 * priceChart.test.ts): candles and the live curve ticks as slots and points, thinning a line, and
 * the market-cap and time axes. Candles of one timeframe come from the server's candle store
 * (GET /tokens/:mint/candles), which picks the finest width for each stretch itself.
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
  // The grid's zero: the origin, else UTC midnight moved to local midnight.
  const zero = origin ?? new Date(t0).getTimezoneOffset() * MINUTE;
  // The finest step whose round times in the window number `max` or fewer. Counting the times
  // themselves, not the span over the step, keeps a 19-hour view on 6-hour ticks (three labels)
  // rather than one 12-hour tick.
  const count = (s: number) => {
    const first = zero + Math.ceil((t0 - zero) / s) * s;
    return first > t1 ? 0 : Math.floor((t1 - first) / s) + 1;
  };
  const step = TIME_STEPS.find((s) => count(s) <= max) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
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
 * The market-cap axis over [lo, hi], drawn from `top` to `bottom` px: linear on round steps, never
 * below zero (user ask 2026-10-19: linear by default everywhere). With `log` (the chart's Log
 * switch) a coin that moved more than 4x in view gets a log axis instead, ticks on 1, 2 and 5
 * times a power of ten, so a run from $8K to $400K doesn't flatten everything before it.
 */
export function mcapAxis(
  lo: number,
  hi: number,
  top: number,
  bottom: number,
  maxTicks = 5,
  logScale = false,
): Axis {
  if (!(lo > 0) || !(hi > 0)) {
    lo = 1;
    hi = 10;
  }
  if (hi <= lo) {
    // A flat line: give it some room either side.
    hi = lo * 1.05;
    lo = lo * 0.95;
  }
  const log = logScale && hi / lo > 4;
  if (log) {
    // A little headroom either side, in log terms.
    const pad = (Math.log(hi) - Math.log(lo)) * 0.06;
    const a = Math.log(lo) - pad;
    const b = Math.log(hi) + pad;
    const y = (v: number) => bottom - ((Math.log(Math.max(v, 1e-9)) - a) / (b - a)) * (bottom - top);
    return { y, ticks: logTicks(Math.exp(a), Math.exp(b), maxTicks), log };
  }
  const span = hi - lo;
  const a = Math.max(0, lo - span * 0.08);
  const b = hi + span * 0.08;
  const y = (v: number) => bottom - ((v - a) / (b - a)) * (bottom - top);
  return { y, ticks: linearTicks(a, b, maxTicks), log };
}

/**
 * The value axis zoomed by hand (user ask 2026-10-19: zoom either axis): its bottom and top as
 * fractions of the fitted range, 0 at the data's low and 1 at its high (in log terms on a log
 * axis). Null fits the data, as before.
 */
export interface ValueZoom {
  a: number;
  b: number;
}

/** The fitted axis's own reach, in ValueZoom terms: about its padding either side. */
const FIT_ZOOM: ValueZoom = { a: -0.08, b: 1.08 };

/** Exported for tests. The value window a zoom shows over data from `lo` to `hi`, never below zero. */
export function valueWindow(lo: number, hi: number, vz: ValueZoom, log: boolean): { lo: number; hi: number } {
  if (!(lo > 0) || !(hi > 0)) {
    lo = 1;
    hi = 10;
  }
  if (hi <= lo) {
    hi = lo * 1.05;
    lo = lo * 0.95;
  }
  if (log) {
    const l = Math.log(lo);
    const s = Math.log(hi) - l;
    return { lo: Math.exp(l + s * vz.a), hi: Math.exp(l + s * vz.b) };
  }
  const s = hi - lo;
  const top = lo + s * vz.b;
  return { lo: Math.min(Math.max(0, lo + s * vz.a), top * 0.999), hi: top };
}

/**
 * Exported for tests. The value zoom scaled by `factor` (under 1 zooms in) about `at` of its
 * height (0 the bottom, 1 the top), between a fiftieth of the data's range and twenty times it.
 */
export function zoomValue(vz: ValueZoom | null, factor: number, at = 0.5): ValueZoom {
  const w = vz ?? FIT_ZOOM;
  const span = w.b - w.a;
  const next = Math.min(20, Math.max(0.02, span * factor));
  const pivot = w.a + at * span;
  const a = pivot - at * next;
  return { a, b: a + next };
}

/** Exported for tests. The value zoom moved by `frac` of its height (up when positive). */
export function panValue(vz: ValueZoom | null, frac: number): ValueZoom {
  const w = vz ?? FIT_ZOOM;
  const d = frac * (w.b - w.a);
  return { a: w.a + d, b: w.b + d };
}

/** The value axis over exactly [lo, hi], unpadded, for a hand-zoomed window. */
export function windowAxis(
  lo: number,
  hi: number,
  log: boolean,
  top: number,
  bottom: number,
  maxTicks = 5,
): Axis {
  if (log) {
    const a = Math.log(lo);
    const b = Math.log(hi);
    const y = (v: number) => bottom - ((Math.log(Math.max(v, 1e-9)) - a) / (b - a)) * (bottom - top);
    // Zoomed in close, a log axis can hold no 1-2-5 value: round linear ones read as well there.
    const ticks = logTicks(lo, hi, maxTicks);
    return { y, ticks: ticks.length >= 2 ? ticks : linearTicks(lo, hi, maxTicks), log };
  }
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  return { y, ticks: linearTicks(lo, hi, maxTicks), log };
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
  /** Its high and low, for the candle view; absent, the open and close bound it. */
  h?: number;
  l?: number;
  /** USD volume. Null when the source omitted it: that is not a trade of size 0. */
  vol: number | null;
  /** Its width in ms; a minute when absent (Pump.fun's minute candles). */
  w?: number;
  /**
   * A step between two readings (pointCandles), not a candle: its move happened at its end, so it
   * goes in the slot its end falls in, however long the step.
   */
  tick?: boolean;
}

/**
 * Where a candle goes among `n` slots `slotMs` wide from `t0`: the slot index and how many slots
 * it covers, or null when it falls outside them. A candle no wider than a slot goes by the middle
 * of its width; a wider one (a minute candle among 1-second slots, where the finer candles don't
 * reach) starts at its own start and runs on over the slots its width covers, so it draws at its
 * true width instead of squeezed into one slot with flat dashes after it; a reading's step goes
 * where its end falls.
 */
function slotOf(k: VolumeCandle, t0: number, slotMs: number, n: number): { i: number; span: number } | null {
  const w = k.w ?? MINUTE;
  const t1 = t0 + slotMs * n;
  const clamp = (i: number) => Math.min(n - 1, Math.max(0, i));
  if (k.tick) {
    const end = k.t + w;
    if (end < t0 || end > t1) return null;
    return { i: clamp(Math.floor((end - t0) / slotMs)), span: 1 };
  }
  if (w > slotMs * 1.001) {
    if (k.t + w <= t0 || k.t >= t1) return null;
    const i = Math.floor((k.t - t0) / slotMs);
    const last = Math.ceil((k.t + w - t0) / slotMs) - 1;
    return { i: clamp(i), span: Math.max(1, clamp(last) - clamp(i) + 1) };
  }
  const mid = k.t + w / 2;
  if (mid < t0 || mid > t1) return null;
  return { i: clamp(Math.floor((mid - t0) / slotMs)), span: 1 };
}

/**
 * The bar drawn over slot `i`: its own, or a wider one that started in an earlier slot and runs
 * over it (OhlcBar.span), with the slot it starts in.
 */
export function barOver<B extends { span?: number }>(
  bars: readonly (B | null)[],
  i: number,
): { bar: B; at: number } | null {
  for (let j = i; j >= 0; j--) {
    const b = bars[j];
    if (b) return j + (b.span ?? 1) > i ? { bar: b, at: j } : null;
  }
  return null;
}

/** One bar of the volume lane: the minutes it spans, their USD volume, and the move across them. */
export interface VolumeBar {
  from: number;
  to: number;
  /** Null when every candle in the slice omitted volume. A reported 0 stays 0. */
  usd: number | null;
  o: number;
  c: number;
  /** Slots it covers, from its own: more than one for a candle wider than a slot (slotOf). */
  span?: number;
}

/**
 * Exported for tests. The candles' volume summed into `n` even slices of [t0, t1], each candle by
 * the middle of its own width (a minute, 15 seconds or one); a slice with no candles is null. A
 * slice's open is its first candle's open and its close its last candle's close, so its colour
 * says whether the price rose across it. Candles of different widths that overlap (a coarse bar
 * at a page's seam) count once: a candle starting before the previous one ends is left out.
 */
export function volumeBars(
  candles: readonly VolumeCandle[],
  t0: number,
  t1: number,
  n: number,
): (VolumeBar | null)[] {
  const slotMs = Math.max(1, t1 - t0) / Math.max(1, n);
  const out: (VolumeBar | null)[] = Array.from({ length: n }, () => null);
  let covered = -Infinity;
  for (const k of [...candles].sort((a, b) => a.t - b.t)) {
    const w = k.w ?? MINUTE;
    if (k.t < covered) continue;
    // A candle just outside the slots still counts in the edge one (its slot is cut by the window).
    const mid = k.t + w / 2;
    const at =
      slotOf(k, t0, slotMs, n) ??
      (w <= slotMs * 1.001 && mid >= t0 - w && mid <= t1 + w / 2
        ? { i: mid < t0 ? 0 : n - 1, span: 1 }
        : null);
    if (!at) continue;
    covered = k.t + w;
    const { i } = at;
    const b = out[i];
    if (!b)
      out[i] = {
        from: k.t,
        to: k.t + w,
        usd: k.vol,
        o: k.o,
        c: k.c,
        ...(at.span > 1 ? { span: at.span } : {}),
      };
    else {
      if (k.vol != null) b.usd = (b.usd ?? 0) + k.vol;
      b.to = k.t + w;
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

/** One candle of the candle view: the slice it spans and its open, high, low and close. */
export interface OhlcBar {
  from: number;
  to: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** No trades in its slice: drawn flat at the close before it, so the candles run unbroken. */
  flat?: boolean;
  /** Slots it covers, from its own: more than one for a candle wider than a slot (slotOf). */
  span?: number;
  /** A candle wider than a slot (where no finer candles reach): the chart shades it. */
  coarse?: boolean;
}

/**
 * Exported for tests. The candles with no trades between the first and the last filled in, flat at
 * the close before each, so the candle view runs edge to edge without holes where a coin went quiet
 * (the price held there). Slot i spans [start + i * ms, start + (i + 1) * ms).
 */
export function fillFlat(bars: readonly (OhlcBar | null)[], start: number, ms: number): (OhlcBar | null)[] {
  const out = [...bars];
  let prev: OhlcBar | null = null;
  let prevAt = -1;
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (b) {
      prev = b;
      prevAt = i;
      continue;
    }
    // Under a wider candle running on from an earlier slot: it is drawn there already.
    if (prev && prevAt + (prev.span ?? 1) > i) continue;
    if (!prev || !out.slice(i + 1).some(Boolean)) continue;
    const v = prev.c;
    out[i] = { from: start + i * ms, to: start + (i + 1) * ms, o: v, h: v, l: v, c: v, flat: true };
    prev = out[i]!;
    prevAt = i;
  }
  return out;
}

/**
 * Where the newest candle (the one reaching furthest, as liveCandles takes it) starts, ms;
 * -Infinity without candles. The live readings after it are folded into it.
 */
export function newestCandleStart(candles: readonly VolumeCandle[]): number {
  let start = -Infinity;
  let end = -Infinity;
  for (const k of candles) {
    const e = k.t + (k.w ?? MINUTE);
    if (e > end) [start, end] = [k.t, e];
  }
  return start;
}

/**
 * Exported for tests. The candles with the line's readings after the newest one's start folded in
 * (the live curve's ticks): the newest candle is still forming, so a tick inside it moves its close,
 * high and low, as an exchange chart's last candle moves, rather than waiting for the next candle
 * read; ticks past its end become candles of their own (pointCandles). Without candles, the
 * readings alone.
 */
export function liveCandles(candles: readonly VolumeCandle[], points: readonly Point[]): VolumeCandle[] {
  if (candles.length === 0) return pointCandles(points);
  let n = 0;
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i]!;
    const b = candles[n]!;
    if (k.t + (k.w ?? MINUTE) > b.t + (b.w ?? MINUTE)) n = i;
  }
  const newest = { ...candles[n]! };
  const end = newest.t + (newest.w ?? MINUTE);
  let h = Math.max(newest.h ?? -Infinity, newest.o, newest.c);
  let l = Math.min(newest.l ?? Infinity, newest.o, newest.c);
  for (const p of points) {
    if (p.t <= newest.t || p.t > end || !(p.v > 0)) continue;
    newest.c = p.v;
    h = Math.max(h, p.v);
    l = Math.min(l, p.v);
  }
  newest.h = h;
  newest.l = l;
  const out = candles.map((k, i) => (i === n ? newest : k));
  return out.concat(
    pointCandles(
      points.filter((p) => p.t > end),
      { t: end, v: newest.c },
    ),
  );
}

/**
 * Exported for tests. The candles merged into `n` even slices of [t0, t1], as volumeBars slices
 * them (so a candle sits over its volume bar): each candle by the middle of its width, the slice's
 * open its first candle's open, its close its last one's close, and its high and low theirs. A
 * slice with no candles is null; overlapping candles of different widths count once.
 */
export function ohlcBars(
  candles: readonly VolumeCandle[],
  t0: number,
  t1: number,
  n: number,
): (OhlcBar | null)[] {
  const slotMs = Math.max(1, t1 - t0) / Math.max(1, n);
  const out: (OhlcBar | null)[] = Array.from({ length: n }, () => null);
  let covered = -Infinity;
  for (const k of [...candles].sort((a, b) => a.t - b.t)) {
    const w = k.w ?? MINUTE;
    if (k.t < covered) continue;
    const at = slotOf(k, t0, slotMs, n);
    if (!at) continue;
    covered = k.t + w;
    const h = Math.max(k.h ?? -Infinity, k.o, k.c);
    const l = Math.min(k.l ?? Infinity, k.o, k.c);
    const { i } = at;
    const b = out[i];
    if (!b)
      out[i] = {
        from: k.t,
        to: k.t + w,
        o: k.o,
        h,
        l,
        c: k.c,
        ...(at.span > 1 ? { span: at.span } : {}),
        ...(!k.tick && w > slotMs * 1.001 ? { coarse: true } : {}),
      };
    else {
      b.to = k.t + w;
      b.c = k.c;
      b.h = Math.max(b.h, h);
      b.l = Math.min(b.l, l);
    }
  }
  return out;
}

/**
 * Exported for tests. Line readings as candles, for where there are no real ones (scan readings,
 * the live curve's ticks after the newest candle): one per step from a reading to the next, the
 * first from `start` (the reading before them) when given.
 */
export function pointCandles(points: readonly Point[], start?: Point): VolumeCandle[] {
  const out: VolumeCandle[] = [];
  let prev = start;
  for (const p of points) {
    if (prev && p.t > prev.t) {
      const o = prev.v;
      out.push({
        t: prev.t,
        w: p.t - prev.t,
        o,
        h: Math.max(o, p.v),
        l: Math.min(o, p.v),
        c: p.v,
        vol: 0,
        tick: true,
      });
    }
    prev = p;
  }
  return out;
}

/**
 * A zoomed chart's window: where it starts and ends, and whether it is held to the view's end, so
 * a live view zoomed on its latest minutes follows the new readings.
 */
export interface Zoom {
  from: number;
  to: number;
  end: boolean;
}

/** The narrowest window the chart zooms to. */
export const MIN_ZOOM_MS = 30 * SECOND;

/** A picked timeframe opens with candles about this wide on screen. */
const OPEN_CANDLE_PX = 8;
/**
 * Fine timeframes open further out (user ask 2026-10-19: 1s opened on about a minute, too close to
 * read): on at least this much time, so long as each candle keeps OPEN_MIN_CANDLE_PX or so.
 */
const OPEN_MIN_SPAN_MS = 5 * MINUTE;
const OPEN_MIN_CANDLE_PX = 2;

/**
 * Exported for tests. The window a picked timeframe opens on (or zooms to when picked), for a plot
 * `plotW` px wide: about OPEN_CANDLE_PX a candle, and for the fine ones (1s, 5s on a phone) at
 * least OPEN_MIN_SPAN_MS while candles stay OPEN_MIN_CANDLE_PX wide, leaving room to zoom in.
 */
export function openingSpanMs(tfMs: number, plotW: number): number {
  const readable = tfMs * Math.max(8, Math.round(plotW / OPEN_CANDLE_PX));
  const wide = Math.min(OPEN_MIN_SPAN_MS, tfMs * Math.max(8, Math.round(plotW / OPEN_MIN_CANDLE_PX)));
  return Math.max(MIN_ZOOM_MS, readable, wide);
}

/** Exported for tests. The window a zoom shows inside the view [t0, t1]: the whole view without one. */
export function zoomWindow(zoom: Zoom | null, t0: number, t1: number): { from: number; to: number } {
  if (!zoom || t1 <= t0) return { from: t0, to: t1 };
  const span = Math.min(Math.max(1, zoom.to - zoom.from), t1 - t0);
  const to = zoom.end ? t1 : Math.min(t1, Math.max(t0 + span, zoom.to));
  return { from: Math.max(t0, to - span), to };
}

/** A window clamped into the view; null once it covers all of it (zoomed back out). */
function clampZoom(from: number, span: number, t0: number, t1: number): Zoom | null {
  const full = t1 - t0;
  if (span >= full - 1) return null;
  const start = Math.min(Math.max(t0, from), t1 - span);
  return { from: start, to: start + span, end: start + span >= t1 - 1 };
}

/**
 * Exported for tests. The window scaled by `factor` (under 1 zooms in) about the moment `at` of
 * the way across it (0 the left edge, 1 the right), which stays where it is on screen; never
 * narrower than `minMs` and never past the view [t0, t1]. Null when it would cover the whole view.
 */
export function zoomBy(
  win: { from: number; to: number },
  t0: number,
  t1: number,
  factor: number,
  at = 0.5,
  minMs = MIN_ZOOM_MS,
  maxMs = Infinity,
): Zoom | null {
  const span = win.to - win.from;
  const next = Math.min(t1 - t0, maxMs, Math.max(Math.min(minMs, t1 - t0), span * factor));
  const anchor = win.from + at * span;
  return clampZoom(anchor - at * next, next, t0, t1);
}

/** Exported for tests. The window moved by `dt` ms (later when positive), kept inside the view. */
export function panBy(win: { from: number; to: number }, t0: number, t1: number, dt: number): Zoom | null {
  return clampZoom(win.from + dt, win.to - win.from, t0, t1);
}

/**
 * Exported for tests. The line inside [t0, t1]: its points there, with its value at each edge
 * added (as the line draws it), so a zoomed window's line runs edge to edge.
 */
export function clipPoints(points: readonly Point[], t0: number, t1: number): Point[] {
  const inside = points.filter((p) => p.t > t0 && p.t < t1);
  const a = valueAt(points, t0);
  const b = valueAt(points, t1);
  return [
    ...(a !== null ? [{ t: t0, v: a }] : []),
    ...inside,
    ...(b !== null && t1 > t0 ? [{ t: t1, v: b }] : []),
  ];
}

/** The candle view's timeframes (user ask 2026-10-18), narrowest first. */
export const TIMEFRAMES: { ms: number; label: string }[] = [
  { ms: SECOND, label: "1s" },
  { ms: 5 * SECOND, label: "5s" },
  { ms: 15 * SECOND, label: "15s" },
  { ms: 30 * SECOND, label: "30s" },
  { ms: MINUTE, label: "1m" },
  { ms: 5 * MINUTE, label: "5m" },
  { ms: 15 * MINUTE, label: "15m" },
  { ms: 30 * MINUTE, label: "30m" },
  { ms: HOUR, label: "1h" },
  { ms: 4 * HOUR, label: "4h" },
];

/** A timeframe's label ("15s", "1h"); a width between them reads in seconds or minutes. */
export function timeframeLabel(ms: number): string {
  const tf = TIMEFRAMES.find((f) => f.ms === ms);
  if (tf) return tf.label;
  if (ms >= 24 * HOUR && ms % (24 * HOUR) === 0) return `${ms / (24 * HOUR)}d`;
  if (ms >= HOUR && ms % HOUR === 0) return `${ms / HOUR}h`;
  return ms < MINUTE ? `${Math.round(ms / SECOND)}s` : `${Math.round(ms / MINUTE)}m`;
}

/**
 * Exported for tests. The timeframe the candle view draws for a picked one: the picked one, or the
 * next wider one when the data in view is coarser (a minute candle can't be split into seconds) or
 * when the window holds more than `maxBars` of them (thinner than the screen can show).
 */
export function candleTimeframe(
  pickedMs: number,
  finestMs: number,
  spanMs: number,
  maxBars: number,
  widths: readonly number[] = TIMEFRAMES.map((f) => f.ms),
): number {
  const need = Math.max(pickedMs, finestMs);
  return widths.find((ms) => ms >= need && spanMs / ms <= maxBars) ?? widths[widths.length - 1]!;
}

/**
 * Zoomed out, a picked timeframe's candles thin down to about this wide (px a candle) and the
 * zoom stops there (user ask 2026-10-19: the candle size locks), rather than drawing a wider one.
 */
const LOCK_MIN_SLOT_PX = 1;
/** Zoomed in, candles widen up to about this (px a candle) and the zoom stops there. */
export const MAX_SLOT_PX = 48;
/** Auto keeps the width it drew while its candles stay at least this wide (px), as it zooms. */
const AUTO_MIN_SLOT_PX = 3;

/**
 * Exported for tests. The narrowest and widest windows (ms) a picked timeframe `tfMs` zooms
 * between on a plot `plotW` px wide, inside a view `viewMs` long: in as far as three candles or
 * MAX_SLOT_PX a candle, whichever is further out, and out as far as LOCK_MIN_SLOT_PX a candle. The
 * candles keep the picked width throughout (user ask 2026-10-19).
 */
export function lockedSpans(tfMs: number, plotW: number, viewMs: number): { min: number; max: number } {
  const view = Math.max(1, viewMs);
  const min = Math.min(view, Math.max(tfMs * 3, (tfMs * plotW) / MAX_SLOT_PX));
  const max = Math.min(view, Math.max(min, tfMs * Math.floor(Math.max(1, plotW) / LOCK_MIN_SLOT_PX)));
  return { min, max };
}

/**
 * Exported for tests. Auto's width for a window `spanMs` long on a plot `plotW` px wide: the one it
 * drew before (`prevMs`) while its candles stay between AUTO_MIN_SLOT_PX and MAX_SLOT_PX wide, so
 * a zoom changes how wide they draw rather than what each one covers; else, or with none before,
 * the narrowest that leaves `candlePx` a candle, never finer than the finest candles in view.
 */
export function autoTimeframe(
  prevMs: number | null,
  finestMs: number,
  spanMs: number,
  plotW: number,
  candlePx: number,
  widths: readonly number[] = AUTO_TIMEFRAMES_MS,
): number {
  if (prevMs !== null && prevMs >= finestMs && widths.includes(prevMs)) {
    const slot = (plotW * prevMs) / Math.max(1, spanMs);
    if (slot >= AUTO_MIN_SLOT_PX && slot <= MAX_SLOT_PX) return prevMs;
  }
  return candleTimeframe(finestMs, finestMs, spanMs, Math.max(1, Math.floor(plotW / candlePx)), widths);
}

/**
 * The widths Auto picks from: the timeframes with steps between them, so the candles in view
 * come close to filling the plot (1m to 5m was too big a jump: a 2-hour view drew 25 candles).
 */
export const AUTO_TIMEFRAMES_MS: readonly number[] = [1, 2, 5, 10, 15, 30]
  .map((s) => s * SECOND)
  .concat([1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 1440].map((m) => m * MINUTE));

/**
 * Exported for tests. Slots `ms` wide over [t0, t1], on round multiples of it since `origin` (the
 * epoch, or the First 15m view's launch), so a 5-minute candle covers :00 to :05 and keeps its
 * place as the window moves: where the first starts, and how many there are.
 */
export function timeframeSlots(t0: number, t1: number, ms: number, origin = 0): { start: number; n: number } {
  const start = origin + Math.floor((t0 - origin) / ms) * ms;
  return { start, n: Math.max(1, Math.ceil((t1 - start) / ms)) };
}
