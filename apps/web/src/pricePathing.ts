/**
 * Predictive price pathing (experimental, user ask 2026-10-18): a short-range guess at where a
 * coin's market cap goes next, drawn on the token chart as a dotted line in 5-second steps when the
 * viewer turns it on in Customize (off by default).
 *
 * It reads the price second by second: the chart's points (live curve ticks and Pump.fun's
 * 1-second candles) are laid on a one-second grid, a few path features are read off the last
 * minute, and one small linear model per step ahead gives the expected log change from now. The
 * model's numbers (PATH_MODEL) are fitted offline from real 1-second paths by
 * apps/web/scripts/fitPricePathing.ts, which also backtests them against a "stays flat" guess on
 * coins it did not train on; its report is in that script's header. Plain arithmetic, so it runs in
 * the browser on what the chart already has: no extra upstream calls.
 */

import { PATH_MODEL } from "./pricePathingModel";

/** One grid second. */
const SECOND = 1_000;
/** Seconds of history the features read. */
export const PATH_LOOKBACK_SEC = 60;
/** Fewest seconds with a price change in the lookback for a guess to be drawn at all. */
export const PATH_MIN_ACTIVE_SEC = 8;

/** The fitted model: per step ahead, ridge weights over the standardized features. */
export interface PathModel {
  version: number;
  /** Seconds between drawn steps. */
  stepSec: number;
  /** Seconds ahead of each step, ascending (5, 10, ...). */
  horizons: number[];
  /** Feature means and spreads the weights were fitted on (standardization). */
  mean: number[];
  scale: number[];
  /** Per horizon: one weight per feature, then the intercept; the answer is a log change. */
  weights: number[][];
  /**
   * Per horizon: the 10th and 90th percentile of the fitted errors, in units of the coin's recent
   * one-second volatility times the square root of the seconds ahead (the band around the line).
   */
  bandLo: number[];
  bandHi: number[];
  /**
   * Version 2: per horizon, quantile-regression weights (one per standardized feature, then the
   * intercept) for the band's 10th and 90th percentile in the same units, so the band follows the
   * coin's state (wider below after a run-up, say) instead of one shape for every coin. bandLo and
   * bandHi stay as the fallback.
   */
  bandLoW?: number[][];
  bandHiW?: number[][];
}

/**
 * The price at every whole second from `from` to `to` (inclusive), in natural log: each second
 * takes the last reading at or before it, and seconds before the first reading are NaN.
 */
export function secondGrid(points: readonly { t: number; v: number }[], from: number, to: number): number[] {
  const n = Math.max(0, Math.floor((to - from) / SECOND) + 1);
  const out = new Array<number>(n).fill(Number.NaN);
  let j = 0;
  let last = Number.NaN;
  for (let i = 0; i < n; i++) {
    const t = from + i * SECOND;
    while (j < points.length && points[j]!.t <= t) {
      const v = points[j]!.v;
      if (v > 0 && Number.isFinite(v)) last = Math.log(v);
      j++;
    }
    out[i] = last;
  }
  return out;
}

/** Feature names, in the order pathFeatures gives them (and the model's weights read them). */
export const PATH_FEATURES = [
  "ret5",
  "ret15",
  "ret30",
  "ret60",
  "vol30",
  "active30",
  "fromHigh60",
  "fromLow60",
  "accel",
  "logMcap",
  "logVol30",
] as const;

/**
 * The path features at the grid's last second, from its last PATH_LOOKBACK_SEC + 1 seconds of log
 * price: log changes over 5, 15, 30 and 60 seconds, the one-second volatility and the share of
 * seconds that moved over the last 30, how far the price sits under its minute high and over its
 * minute low, whether the last 15 seconds ran faster than the 15 before, and the coin itself: its
 * market cap (log) and its USD volume over the last 30 seconds (log of 1 + it). Null when the grid
 * is too short, has unknown seconds, or moved on fewer than PATH_MIN_ACTIVE_SEC seconds.
 */
export function pathFeatures(grid: readonly number[], volUsd30 = 0): number[] | null {
  const n = grid.length;
  if (n < PATH_LOOKBACK_SEC + 1) return null;
  const w = grid.slice(n - PATH_LOOKBACK_SEC - 1);
  if (w.some((x) => !Number.isFinite(x))) return null;
  const now = w[w.length - 1]!;
  const ago = (s: number) => w[w.length - 1 - s]!;
  let active = 0;
  let active30 = 0;
  let sq = 0;
  for (let i = 1; i < w.length; i++) {
    const d = w[i]! - w[i - 1]!;
    if (d !== 0) {
      active++;
      if (i > w.length - 31) active30++;
    }
    if (i > w.length - 31) sq += d * d;
  }
  if (active < PATH_MIN_ACTIVE_SEC) return null;
  const hi = Math.max(...w);
  const lo = Math.min(...w);
  const ret15 = now - ago(15);
  const prev15 = ago(15) - ago(30);
  return [
    now - ago(5),
    ret15,
    now - ago(30),
    now - ago(60),
    Math.sqrt(sq / 30),
    active30 / 30,
    now - hi,
    now - lo,
    ret15 - prev15,
    now,
    Math.log1p(Math.max(0, volUsd30)),
  ];
}

/** The expected log change at each of the model's horizons, from the features. */
export function predictLogChanges(features: readonly number[], model: PathModel = PATH_MODEL): number[] {
  const z = standardize(features, model);
  return model.weights.map((wts) => linear(wts, z));
}

/** The features standardized as the model was fitted on them. */
function standardize(features: readonly number[], model: PathModel): number[] {
  return features.map((x, k) => (x - model.mean[k]!) / (model.scale[k]! || 1));
}

/** Weights (one per input, then the intercept) applied to `z`. */
function linear(w: readonly number[], z: readonly number[]): number {
  let y = w[w.length - 1]!;
  for (let k = 0; k < z.length; k++) y += w[k]! * z[k]!;
  return y;
}

/**
 * The band's 10th and 90th percentile at each horizon, in units of the recent one-second
 * volatility times the square root of the seconds ahead: from the coin's state where the model has
 * band weights, else the fixed ones. Ordered low to high.
 */
export function bandUnits(
  features: readonly number[],
  model: PathModel = PATH_MODEL,
): { lo: number[]; hi: number[] } {
  if (!model.bandLoW || !model.bandHiW) return { lo: [...model.bandLo], hi: [...model.bandHi] };
  const z = standardize(features, model);
  const lo: number[] = [];
  const hi: number[] = [];
  model.horizons.forEach((_, i) => {
    const a = linear(model.bandLoW![i]!, z);
    const b = linear(model.bandHiW![i]!, z);
    lo.push(Math.min(a, b));
    hi.push(Math.max(a, b));
  });
  return { lo, hi };
}

/** One drawn step of the guessed path: its time, the guessed market cap, and the band around it. */
export interface PathStep {
  t: number;
  v: number;
  lo: number;
  hi: number;
}

/** USD volume of the candles that start in the 30 seconds up to `end` (each candle by its start). */
export function volumeBefore(candles: readonly { t: number; vol?: number }[], end: number): number {
  let sum = 0;
  for (const k of candles) if (k.t >= end - 30 * SECOND && k.t < end) sum += k.vol ?? 0;
  return sum;
}

/** What the model reads at one moment: the expected log change per horizon and the band's unit. */
export interface PathGuess {
  /** The grid second the guess was read at (ms). */
  at: number;
  ys: number[];
  /** Recent one-second volatility, floored so a quiet coin still shows some spread. */
  vol: number;
  /** The band per horizon, in bandUnits' units. */
  lo: number[];
  hi: number[];
}

/**
 * The model's guess from the chart's points (market cap) at `now`. `candles` (1-second, with USD
 * volume) give the volume feature. Null when there is too little recent trading to read one.
 */
export function guessPath(
  points: readonly { t: number; v: number }[],
  now: number,
  candles: readonly { t: number; vol?: number }[] = [],
  model: PathModel = PATH_MODEL,
): PathGuess | null {
  const end = Math.floor(now / SECOND) * SECOND;
  const grid = secondGrid(points, end - PATH_LOOKBACK_SEC * SECOND, end);
  const f = pathFeatures(grid, volumeBefore(candles, end));
  if (!f) return null;
  return { at: end, ys: predictLogChanges(f, model), vol: Math.max(f[4]!, 0.002), ...bandUnits(f, model) };
}

/**
 * The drawn path for a guess, from `start` (the line's latest reading): the start, then one step
 * per horizon, the guessed change applied to the start's price with its band around it.
 */
export function pathFrom(
  guess: PathGuess,
  start: { t: number; v: number },
  model: PathModel = PATH_MODEL,
): PathStep[] {
  if (!(start.v > 0)) return [];
  const base = Math.log(start.v);
  const steps: PathStep[] = [{ t: start.t, v: start.v, lo: start.v, hi: start.v }];
  model.horizons.forEach((h, i) => {
    const spread = guess.vol * Math.sqrt(h);
    const y = guess.ys[i]!;
    steps.push({
      t: start.t + h * SECOND,
      v: Math.exp(base + y),
      lo: Math.exp(base + y + guess.lo[i]! * spread),
      hi: Math.exp(base + y + guess.hi[i]! * spread),
    });
  });
  return steps;
}

/**
 * The guessed path from the chart's points (market cap) at `now`: the starting point (now's
 * price) and then one step per horizon. `candles` (1-second, with USD volume) give the volume
 * feature. Empty when there is too little recent trading to read a path from.
 */
export function predictPath(
  points: readonly { t: number; v: number }[],
  now: number,
  candles: readonly { t: number; vol?: number }[] = [],
  model: PathModel = PATH_MODEL,
): PathStep[] {
  const guess = guessPath(points, now, candles, model);
  if (!guess) return [];
  const grid = secondGrid(points, guess.at, guess.at);
  return pathFrom(guess, { t: guess.at, v: Math.exp(grid[0]!) }, model);
}
