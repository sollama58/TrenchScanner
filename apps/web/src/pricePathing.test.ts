import { describe, expect, it } from "vitest";
import {
  bandUnits,
  pathFeatures,
  pathFrom,
  predictPath,
  secondGrid,
  volumeBefore,
  type PathModel,
} from "./pricePathing";
import {
  backtest,
  coinSamples,
  fitPathModel,
  quantile,
  ridge,
  ridgeMedian,
  ridgeQuantile,
} from "./pricePathingFit";

const flatModel = (h: number[], d = 11): PathModel => ({
  version: 1,
  stepSec: 5,
  horizons: h,
  mean: new Array<number>(d).fill(0),
  scale: new Array<number>(d).fill(1),
  weights: h.map(() => new Array<number>(d + 1).fill(0)),
  bandLo: h.map(() => -1),
  bandHi: h.map(() => 1),
});

/** A price that ticks every second: up by `drift` with a small alternating wiggle. */
const ticking = (start: number, secs: number, drift = 0) =>
  Array.from({ length: secs }, (_, i) => ({
    t: start + i * 1_000,
    v: 1000 * Math.exp(drift * i + (i % 2) * 0.01),
  }));

describe("secondGrid", () => {
  it("forward-fills the last reading at or before each second, NaN before the first", () => {
    const g = secondGrid(
      [
        { t: 1_500, v: Math.E },
        { t: 3_000, v: Math.E ** 2 },
      ],
      0,
      4_000,
    );
    expect(g[0]).toBeNaN();
    expect(g[1]).toBeNaN();
    expect(g[2]).toBeCloseTo(1);
    expect(g[3]).toBeCloseTo(2);
    expect(g[4]).toBeCloseTo(2);
  });
});

describe("pathFeatures", () => {
  it("reads returns over the lookback, and the coin's market cap and volume", () => {
    const grid = Array.from({ length: 61 }, (_, i) => i * 0.01);
    const f = pathFeatures(grid, 99)!;
    expect(f[0]).toBeCloseTo(0.05);
    expect(f[3]).toBeCloseTo(0.6);
    expect(f[5]).toBeCloseTo(1);
    expect(f[6]).toBeCloseTo(0);
    expect(f[9]).toBeCloseTo(0.6);
    expect(f[10]).toBeCloseTo(Math.log(100));
  });

  it("gives nothing for a quiet minute, a short grid or unknown seconds", () => {
    expect(pathFeatures(new Array<number>(61).fill(1))).toBeNull();
    expect(pathFeatures([1, 2, 3])).toBeNull();
    const g = Array.from({ length: 61 }, (_, i) => i * 0.01);
    g[3] = Number.NaN;
    expect(pathFeatures(g)).toBeNull();
  });
});

describe("predictPath", () => {
  it("starts at the latest price and steps every 5 seconds with a band around the guess", () => {
    const pts = ticking(0, 90);
    const steps = predictPath(pts, 89_000, [], flatModel([5, 10, 15]));
    expect(steps.map((s) => s.t)).toEqual([89_000, 94_000, 99_000, 104_000]);
    // A model with no weights guesses flat.
    for (const s of steps) expect(s.v).toBeCloseTo(pts[89]!.v);
    expect(steps[3]!.lo).toBeLessThan(steps[3]!.v);
    expect(steps[3]!.hi).toBeGreaterThan(steps[3]!.v);
    // The band widens with the distance ahead.
    expect(steps[3]!.hi - steps[3]!.lo).toBeGreaterThan(steps[1]!.hi - steps[1]!.lo);
  });

  it("draws nothing without enough recent trading", () => {
    expect(predictPath([{ t: 0, v: 5 }], 90_000, [], flatModel([5]))).toEqual([]);
  });

  it("follows the model's weights", () => {
    const m = flatModel([5]);
    m.weights[0]![11] = 0.1; // the intercept: +0.1 log
    const [, s] = predictPath(ticking(0, 90), 89_000, [], m);
    expect(s!.v / ticking(0, 90)[89]!.v).toBeCloseTo(Math.exp(0.1));
  });
});

describe("volumeBefore", () => {
  it("sums the candles that started in the 30 seconds before", () => {
    const c = [
      { t: 0, vol: 5 },
      { t: 40_000, vol: 1 },
      { t: 69_000, vol: 2 },
      { t: 70_000, vol: 7 },
    ];
    expect(volumeBefore(c, 70_000)).toBe(3);
  });
});

describe("fitting", () => {
  it("ridge recovers a linear relation", () => {
    const z = Array.from({ length: 200 }, (_, i) => [Math.sin(i), Math.cos(i * 1.3)]);
    const y = z.map(([a, b]) => 2 * a! - b! + 0.5);
    const w = ridge(z, y, 0);
    expect(w[0]).toBeCloseTo(2);
    expect(w[1]).toBeCloseTo(-1);
    expect(w[2]).toBeCloseTo(0.5);
  });

  it("the median fit ignores a few wild outliers", () => {
    const z = Array.from({ length: 200 }, (_, i) => [Math.sin(i)]);
    const y = z.map(([a], i) => (i % 25 === 0 ? 50 : 3 * a!));
    const w = ridgeMedian(z, y, 0);
    expect(w[0]).toBeCloseTo(3, 1);
    expect(Math.abs(w[1]!)).toBeLessThan(0.05);
  });

  it("quantile interpolates between order statistics", () => {
    expect(quantile([3, 1, 2, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([], 0.5)).toBe(0);
  });

  it("samples a coin's candles, fits and backtests without errors", () => {
    const candles = Array.from({ length: 400 }, (_, i) => ({
      t: i * 1_000,
      c: 1000 * Math.exp(Math.sin(i / 7) * 0.05 + (i % 3) * 0.003),
      vol: 1,
    }));
    const h = [5, 10];
    const rows = ["a", "b", "c", "d"].flatMap((coin) => coinSamples(coin, candles, h));
    expect(rows.length).toBeGreaterThan(0);
    const model = fitPathModel(rows, h);
    const report = backtest(model, rows);
    expect(report).toHaveLength(2);
    expect(report[0]!.bandCoverage).toBeGreaterThan(0.5);
    // A smooth wave is predictable: the fit beats a flat guess on it.
    expect(report[0]!.skill).toBeGreaterThan(0);
  });
});

describe("pathFrom", () => {
  it("draws a guess from the line's latest point, its band around it", () => {
    const model = {
      version: 1,
      stepSec: 5,
      horizons: [5, 10],
      mean: [],
      scale: [],
      weights: [],
      bandLo: [-1, -1],
      bandHi: [1, 1],
    };
    const steps = pathFrom(
      { at: 0, ys: [0.1, 0.2], vol: 0.01, lo: [-1, -1], hi: [1, 1] },
      { t: 7_000, v: 100 },
      model,
    );
    expect(steps.map((s) => s.t)).toEqual([7_000, 12_000, 17_000]);
    expect(steps[0]).toEqual({ t: 7_000, v: 100, lo: 100, hi: 100 });
    expect(steps[2]!.v).toBeCloseTo(100 * Math.exp(0.2));
    expect(steps[2]!.lo).toBeLessThan(steps[2]!.v);
    expect(steps[2]!.hi).toBeGreaterThan(steps[2]!.v);
  });
});

describe("the band from the coin's state", () => {
  it("fits a quantile: about a tenth of the points fall under the 10th percentile line", () => {
    // y spreads wider as x grows: the 10th percentile falls with x.
    const z: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = (i % 20) / 10 - 1;
      const u = ((i * 7919) % 1000) / 1000 - 0.5;
      z.push([x]);
      y.push(u * (1.5 + x));
    }
    const w = ridgeQuantile(z, y, 0.1, 0);
    const under = z.filter((row, i) => y[i]! < w[0]! * row[0]! + w[1]!).length / z.length;
    expect(under).toBeGreaterThan(0.07);
    expect(under).toBeLessThan(0.13);
    expect(w[0]!).toBeLessThan(0);
  });

  it("reads the band from the features when the model has band weights", () => {
    const m = { ...flatModel([5], 2), bandLoW: [[-0.5, 0, -1]], bandHiW: [[0.5, 0, 1]] };
    expect(bandUnits([2, 0], m)).toEqual({ lo: [-2], hi: [2] });
    // Without them, the fixed band.
    expect(bandUnits([2, 0], flatModel([5], 2))).toEqual({ lo: [-1], hi: [1] });
  });
});
