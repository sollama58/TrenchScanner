/**
 * Fitting and backtesting predictive price pathing (pricePathing.ts). Not part of the page: used by
 * apps/web/scripts/fitPricePathing.ts and the tests. Plain arithmetic, no dependencies.
 */

import { pathFeatures, PATH_LOOKBACK_SEC, secondGrid, volumeBefore, type PathModel } from "./pricePathing";

/** One decision moment: the features then, and the real log change at each horizon after. */
export interface PathSample {
  coin: string;
  features: number[];
  /** Real log change at each horizon. */
  ys: number[];
}

/** One-second candles (epoch ms start, close as market cap, USD volume). */
export interface SecondCandle {
  t: number;
  c: number;
  vol?: number;
}

/**
 * Decision moments every `everySec` seconds along one coin's 1-second candles, wherever the last
 * minute traded enough for pathFeatures and the candles reach the farthest horizon. A candle's
 * close is the price from the end of its second. At most `maxPerCoin`, spread evenly.
 */
export function coinSamples(
  coin: string,
  candles: readonly SecondCandle[],
  horizons: readonly number[],
  everySec = 5,
  maxPerCoin = 400,
): PathSample[] {
  if (candles.length < 2) return [];
  const points = candles.map((k) => ({ t: k.t + 1_000, v: k.c }));
  const from = points[0]!.t;
  const to = points[points.length - 1]!.t;
  const grid = secondGrid(points, from, to);
  const far = Math.max(...horizons);
  const out: PathSample[] = [];
  for (let i = PATH_LOOKBACK_SEC; i + far < grid.length; i += everySec) {
    const f = pathFeatures(grid.slice(i - PATH_LOOKBACK_SEC, i + 1), volumeBefore(candles, from + i * 1_000));
    if (!f) continue;
    out.push({ coin, features: f, ys: horizons.map((h) => grid[i + h]! - grid[i]!) });
  }
  if (out.length <= maxPerCoin) return out;
  const stride = out.length / maxPerCoin;
  return Array.from({ length: maxPerCoin }, (_, k) => out[Math.floor(k * stride)]!);
}

/** Solves a x = b for a small symmetric positive-definite a (Gaussian elimination, pivoting). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / (row[i]! || 1e-12));
}

/** Ridge weights (features then intercept) for standardized rows z against y; the intercept is not shrunk. */
export function ridge(z: readonly number[][], y: readonly number[], lambda: number): number[] {
  const d = z[0]?.length ?? 0;
  const a = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
  const b = new Array<number>(d + 1).fill(0);
  for (let i = 0; i < z.length; i++) {
    const x = [...z[i]!, 1];
    for (let r = 0; r <= d; r++) {
      b[r]! += x[r]! * y[i]!;
      for (let c = 0; c <= d; c++) a[r]![c]! += x[r]! * x[c]!;
    }
  }
  for (let k = 0; k < d; k++) a[k]![k]! += lambda * z.length;
  return solve(a, b);
}

/**
 * Weights that minimize the mean absolute error (a median fit, robust to the spikes and rugs
 * memecoin paths are full of), by iteratively reweighted ridge: each round weights a row by one
 * over its last error.
 */
export function ridgeMedian(
  z: readonly number[][],
  y: readonly number[],
  lambda: number,
  rounds = 12,
): number[] {
  let w = ridge(z, y, lambda);
  for (let it = 0; it < rounds; it++) {
    const wt = z.map((row, i) => 1 / Math.max(1e-4, Math.abs(y[i]! - dot(w, row))));
    const sw = wt.reduce((a, b) => a + b, 0) / wt.length;
    const s = wt.map((v) => Math.sqrt(v / sw));
    w = ridgeWeighted(z, y, s, lambda);
  }
  return w;
}

/** Ridge on rows scaled by s (the intercept column scaled too). */
function ridgeWeighted(
  z: readonly number[][],
  y: readonly number[],
  s: readonly number[],
  lambda: number,
): number[] {
  const d = z[0]?.length ?? 0;
  const a = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
  const b = new Array<number>(d + 1).fill(0);
  for (let i = 0; i < z.length; i++) {
    const x = [...z[i]!, 1].map((v) => v * s[i]!);
    const yi = y[i]! * s[i]!;
    for (let r = 0; r <= d; r++) {
      b[r]! += x[r]! * yi;
      for (let c = 0; c <= d; c++) a[r]![c]! += x[r]! * x[c]!;
    }
  }
  for (let k = 0; k < d; k++) a[k]![k]! += lambda * z.length;
  return solve(a, b);
}

/** The q-th quantile (0..1) of xs, linear between order statistics. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Targets are clipped to this log change for fitting, so a few rugs and spikes don't steer it. */
const CLIP = 0.3;
const LAMBDAS = [0.01, 0.1, 1, 10, 100, 1000];

const vol = (f: readonly number[]) => Math.max(f[4]!, 0.002);

/**
 * Fits the model on `train`: standardization, then per horizon a median (absolute error) ridge fit whose strength
 * is picked by a 3-fold split by coin (the strongest shrinkage wins ties, so a horizon with nothing
 * to learn is drawn flat), and the band from the fitted errors.
 */
export function fitPathModel(
  train: readonly PathSample[],
  horizons: readonly number[],
  stepSec = 5,
): PathModel {
  const d = train[0]!.features.length;
  const mean = Array.from(
    { length: d },
    (_, k) => train.reduce((s, r) => s + r.features[k]!, 0) / train.length,
  );
  const scale = Array.from({ length: d }, (_, k) => {
    const v = train.reduce((s, r) => s + (r.features[k]! - mean[k]!) ** 2, 0) / train.length;
    return Math.sqrt(v) || 1;
  });
  const zOf = (r: PathSample) => r.features.map((x, k) => (x - mean[k]!) / scale[k]!);
  const z = train.map(zOf);
  const coins = [...new Set(train.map((r) => r.coin))];
  const fold = new Map(coins.map((c, i) => [c, i % 3]));
  const weights: number[][] = [];
  const bandLo: number[] = [];
  const bandHi: number[] = [];
  horizons.forEach((h, hi) => {
    const y = train.map((r) => Math.max(-CLIP, Math.min(CLIP, r.ys[hi]!)));
    let best = { lambda: LAMBDAS[LAMBDAS.length - 1]!, err: Infinity };
    for (const lambda of [...LAMBDAS].reverse()) {
      let err = 0;
      for (let f = 0; f < 3; f++) {
        const idx = train.map((r, i) => (fold.get(r.coin) === f ? -1 : i)).filter((i) => i >= 0);
        const w = ridgeMedian(
          idx.map((i) => z[i]!),
          idx.map((i) => y[i]!),
          lambda,
        );
        train.forEach((r, i) => {
          if (fold.get(r.coin) !== f) return;
          err += Math.abs(r.ys[hi]! - dot(w, z[i]!));
        });
      }
      // A weaker shrinkage has to beat the stronger by a margin to be picked.
      if (err < best.err * 0.999) best = { lambda, err };
    }
    const w = ridgeMedian(z, y, best.lambda);
    weights.push(w);
    const res = train.map((r, i) => (r.ys[hi]! - dot(w, z[i]!)) / (vol(r.features) * Math.sqrt(h)));
    bandLo.push(quantile(res, 0.1));
    bandHi.push(quantile(res, 0.9));
  });
  return { version: 1, stepSec, horizons: [...horizons], mean, scale, weights, bandLo, bandHi };
}

function dot(w: readonly number[], z: readonly number[]): number {
  let y = w[w.length - 1]!;
  for (let k = 0; k < z.length; k++) y += w[k]! * z[k]!;
  return y;
}

/** How one horizon did on held-out moments. */
export interface HorizonReport {
  horizon: number;
  samples: number;
  /** Mean absolute log change error: the model, a "stays flat" guess, and a "keeps its last 5s pace" guess. */
  maeModel: number;
  maeFlat: number;
  maeMomentum: number;
  /** 1 - maeModel / maeFlat: above 0 beats the flat guess. */
  skill: number;
  /** Of moments where the price did move and the model leaned one way, how often the lean was right. */
  directionHit: number;
  directionSamples: number;
  /** Share of real outcomes inside the drawn band (fitted for 80%). */
  bandCoverage: number;
  /** Median width of the band, as a percent of the price. */
  bandWidthPct: number;
}

/** Scores `model` on held-out `test` moments, per horizon. */
export function backtest(model: PathModel, test: readonly PathSample[]): HorizonReport[] {
  return model.horizons.map((h, hi) => {
    let mm = 0;
    let mf = 0;
    let mo = 0;
    let dirN = 0;
    let dirHit = 0;
    let inBand = 0;
    const widths: number[] = [];
    for (const r of test) {
      const z = r.features.map((x, k) => (x - model.mean[k]!) / (model.scale[k]! || 1));
      const p = dot(model.weights[hi]!, z);
      const y = r.ys[hi]!;
      mm += Math.abs(y - p);
      mf += Math.abs(y);
      mo += Math.abs(y - (r.features[0]! * h) / 5);
      if (y !== 0 && Math.abs(p) > 1e-4) {
        dirN++;
        if (Math.sign(p) === Math.sign(y)) dirHit++;
      }
      const s = vol(r.features) * Math.sqrt(h);
      const lo = p + model.bandLo[hi]! * s;
      const up = p + model.bandHi[hi]! * s;
      if (y >= lo && y <= up) inBand++;
      widths.push((Math.exp(up) - Math.exp(lo)) * 100);
    }
    const n = test.length || 1;
    return {
      horizon: h,
      samples: test.length,
      maeModel: mm / n,
      maeFlat: mf / n,
      maeMomentum: mo / n,
      skill: mf > 0 ? 1 - mm / mf : 0,
      directionHit: dirN > 0 ? dirHit / dirN : 0,
      directionSamples: dirN,
      bandCoverage: inBand / n,
      bandWidthPct: quantile(widths, 0.5),
    };
  });
}
