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
 * The closes from `fromMs` on (up to `toMs`, when given), thinned to one point per `widthMs` (aligned to the epoch, so a point
 * keeps its place as new minutes arrive): each point is its slot's last close, at that close's
 * time, so the line ends exactly on the latest reading.
 */
export function linePoints(
  closes: readonly Point[],
  fromMs: number,
  widthMs: number,
  toMs = Infinity,
): Point[] {
  const out: Point[] = [];
  let slot = Number.NaN;
  for (const p of closes) {
    if (p.t < fromMs || p.t > toMs) continue;
    const s = Math.floor(p.t / widthMs);
    if (s === slot) out[out.length - 1] = { t: p.t, v: p.v };
    else out.push({ t: p.t, v: p.v });
    slot = s;
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
export type MarkerKind = "dev" | "risky" | "kol" | "linked";
export const MARKER_KINDS: readonly MarkerKind[] = ["dev", "risky", "kol", "linked"];

/** One flagged wallet's trade, to mark on the chart. */
export interface MarkerTrade {
  t: number;
  side: 1 | -1;
  sol: number | null;
  wallet: string;
  kind: MarkerKind;
}

/** The marked trades of one kind and side at one point of the line, drawn as one marker. */
export interface MarkerGroup {
  /** The point's index. */
  at: number;
  kind: MarkerKind;
  side: 1 | -1;
  trades: MarkerTrade[];
  /** SOL across the trades whose amount is known. */
  sol: number;
  wallets: number;
}

/**
 * Exported for tests. The trades grouped onto the line's points: each trade goes to the nearest
 * point within a step and a half, then per point, kind and side, so a busy bot shows one marker a
 * point rather than a smear. Trades off the line are left out.
 */
export function groupMarkers(
  points: readonly Point[],
  stepMs: number,
  trades: readonly MarkerTrade[],
): MarkerGroup[] {
  if (points.length === 0) return [];
  const groups = new Map<string, MarkerGroup & { seen: Set<string> }>();
  for (const tr of trades) {
    const i = pointAt(points, tr.t);
    const near = [i, i + 1].filter((j) => j >= 0 && j < points.length);
    const at = near.sort((a, b) => Math.abs(points[a]!.t - tr.t) - Math.abs(points[b]!.t - tr.t))[0];
    if (at === undefined || Math.abs(points[at]!.t - tr.t) > stepMs * 1.5) continue;
    const key = `${at}|${tr.kind}|${tr.side}`;
    let g = groups.get(key);
    if (!g) {
      g = { at, kind: tr.kind, side: tr.side, trades: [], sol: 0, wallets: 0, seen: new Set() };
      groups.set(key, g);
    }
    g.trades.push(tr);
    g.sol += tr.sol ?? 0;
    g.seen.add(tr.wallet);
    g.wallets = g.seen.size;
  }
  return [...groups.values()]
    .map(({ seen: _seen, ...g }) => g)
    .sort((a, b) => a.at - b.at || MARKER_KINDS.indexOf(a.kind) - MARKER_KINDS.indexOf(b.kind));
}

/** The last point at or before `t`, or -1. */
function pointAt(points: readonly Point[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
