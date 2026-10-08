import { describe, expect, it } from "vitest";
import { plattScale, scoreBoosted, trainBoostedCurator, type BoostingRow } from "./boosting.js";
import { trainCuratorModel } from "./trainer.js";

const T0 = new Date("2026-08-01T00:00:00Z").getTime();

/** mulberry32 - consecutive draws of the usual LCG are correlated enough to bias a Bernoulli trial. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two signals: `edge` raises the chance of a win; `fuel` decides how far a winner runs (and
 * says nothing about whether it wins). Rows arrive a few a minute, so an hour holds ~200.
 */
function runRows(count: number, seed: number): BoostingRow[] {
  const rand = rng(seed);
  const rows: BoostingRow[] = [];
  for (let i = 0; i < count; i++) {
    const edge = rand();
    const fuel = rand();
    const win = rand() < 0.05 + 0.5 * edge;
    const multiple = win ? 2 + 8 * fuel * fuel : 0.4 + 1.4 * rand();
    rows.push({
      tokenId: `t${i}`,
      anchorAt: new Date(T0 + i * 20_000),
      features: { buyRatio24h: edge, volume1hUsd: fuel * 10_000, ageMinutes: rand() * 300 },
      labelValue: win ? Math.log2(Math.min(multiple, 10)) : 0,
      runPeakMultiple: multiple,
      hit10x: multiple >= 10,
    });
  }
  return rows;
}

function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSum = 0;
  let pos = 0;
  idx.forEach((i, r) => {
    if (labels[i]! > 0) {
      rankSum += r + 1;
      pos += 1;
    }
  });
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * (labels.length - pos));
}

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}
/** The "fuel" signal: how far a winner runs, read back from the volume feature. */
const fuel = (r: BoostingRow) => r.features.volume1hUsd! / 10_000;

describe("boosting objectives", () => {
  it("the run-size objective ranks the big runners above the sure doubles", async () => {
    const train = runRows(4000, 1);
    const test = runRows(2000, 2);
    const runner = await trainBoostedCurator(train, { objective: "runSize" });
    const plain = await trainBoostedCurator(train);
    expect(runner.objective).toBe("runSize");
    expect(plain.objective).toBeUndefined();
    const runnerScores = test.map((r) => scoreBoosted(runner, r.features));
    const plainScores = test.map((r) => scoreBoosted(plain, r.features));
    // Both find the winners (the edge signal caps the reachable AUC); the runner also reads the
    // run-size signal the probability model has little use for.
    const labels = test.map((r) => r.labelValue);
    expect(auc(runnerScores, labels)).toBeGreaterThan(auc(plainScores, labels) - 0.1);
    const f = test.map(fuel);
    expect(corr(runnerScores, f)).toBeGreaterThan(corr(plainScores, f) + 0.2);
    // Platt-scaled: still a probability-shaped score that tracks the clean-2x rate.
    for (const s of runnerScores) expect(s > 0 && s < 1).toBe(true);
    const mean = runnerScores.reduce((a, b) => a + b, 0) / runnerScores.length;
    const base = test.filter((r) => r.labelValue > 0).length / test.length;
    expect(Math.abs(mean - base)).toBeLessThan(0.08);
  });

  it("the ranking objective orders each hour's winners first and runs are rewarded", async () => {
    const train = runRows(4000, 3);
    const test = runRows(2000, 4);
    const ranker = await trainBoostedCurator(train, { objective: "lambdarank" });
    expect(ranker.objective).toBe("lambdarank");
    const plain = await trainBoostedCurator(train);
    const scores = test.map((r) => scoreBoosted(ranker, r.features));
    const plainScores = test.map((r) => scoreBoosted(plain, r.features));
    const labels = test.map((r) => r.labelValue);
    expect(auc(scores, labels)).toBeGreaterThan(auc(plainScores, labels) - 0.1);
    const f = test.map(fuel);
    expect(corr(scores, f)).toBeGreaterThan(corr(plainScores, f) + 0.15);
    for (const s of scores) expect(s > 0 && s < 1).toBe(true);
    const copy = JSON.parse(JSON.stringify(ranker));
    expect(scoreBoosted(copy, test[0]!.features)).toBe(scores[0]);
  });

  it("the run-size objective counts a loss that fell through the stop as -1, not its later peak", async () => {
    // Three segments: plain losses, clean 2.2x winners (60% of the time), and dump-then-pump
    // losers that fell through the stop and only then ran to 6x.
    const rand = rng(11);
    const rows: BoostingRow[] = [];
    for (let i = 0; i < 3000; i++) {
      const segment = i % 3;
      const win = segment === 1 && rand() < 0.6;
      rows.push({
        tokenId: `t${i}`,
        anchorAt: new Date(T0 + i * 20_000),
        features: { buyRatio24h: segment, ageMinutes: rand() * 300 },
        labelValue: win ? Math.log2(2.2) : 0,
        survived: segment !== 2,
        runPeakMultiple: segment === 2 ? 6 : win ? 2.2 : 1.2,
      });
    }
    const runner = await trainBoostedCurator(rows, { objective: "runSize" });
    const score = (segment: number) => scoreBoosted(runner, { buyRatio24h: segment, ageMinutes: 150 });
    expect(score(1)).toBeGreaterThan(score(2));
    expect(score(1)).toBeGreaterThan(score(0));
  });

  it("objectives ride the recipe's boosting options through trainCuratorModel", async () => {
    const rows = runRows(600, 5).map((r) => ({ ...r, anchorPriceUsd: 1e-5, anchorMcapUsd: 50_000 }));
    const params = await trainCuratorModel(rows, {
      learner: "gbdt",
      boosting: { objective: "lambdarank", maxTrees: 20 },
    });
    expect((params as { objective?: string }).objective).toBe("lambdarank");
  });
});

describe("plattScale", () => {
  it("recovers the slope and intercept that generated the labels", () => {
    const rand = rng(9);
    const raw: number[] = [];
    const labels: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const x = rand() * 10;
      const p = 1 / (1 + Math.exp(-(0.8 * x - 5)));
      raw.push(x);
      labels.push(rand() < p ? 1 : 0);
      weights.push(1);
    }
    const { slope, intercept } = plattScale(raw, labels, weights);
    expect(slope).toBeCloseTo(0.8, 1);
    expect(intercept).toBeCloseTo(-5, 0);
  });

  it("converges on clustered and non-monotone scores instead of overshooting", () => {
    // Two clusters a few units apart: raw 0 wins 3%, raw 5 wins 8%. Plain Newton steps from
    // (1, 0) ran off to a slope of ~2e5.
    const raw: number[] = [];
    const labels: number[] = [];
    for (let i = 0; i < 5000; i++) {
      raw.push(0);
      labels.push(i < 150 ? 1 : 0);
    }
    for (let i = 0; i < 1000; i++) {
      raw.push(5);
      labels.push(i < 80 ? 1 : 0);
    }
    const two = plattScale(
      raw,
      labels,
      raw.map(() => 1),
    );
    const p = (x: number) => 1 / (1 + Math.exp(-(two.slope * x + two.intercept)));
    expect(p(0)).toBeCloseTo(0.03, 3);
    expect(p(5)).toBeCloseTo(0.08, 3);

    // Non-monotone: the middle cluster wins, both ends never do.
    const raw3: number[] = [];
    const labels3: number[] = [];
    for (const [x, n, wins] of [
      [2.58, 1000, 0],
      [0.68, 200, 120],
      [-0.3, 4000, 0],
    ] as const) {
      for (let i = 0; i < n; i++) {
        raw3.push(x);
        labels3.push(i < wins ? 1 : 0);
      }
    }
    const three = plattScale(
      raw3,
      labels3,
      raw3.map(() => 1),
    );
    expect(three.slope).toBeLessThan(5);
    for (const x of raw3) {
      const v = 1 / (1 + Math.exp(-(three.slope * x + three.intercept)));
      expect(v > 1e-4 && v < 1 - 1e-4).toBe(true);
    }
  });

  it("never flips an anti-correlated score's order", () => {
    const raw = [0, 1, 2, 3, 4, 5, 6, 7];
    const labels = [1, 1, 1, 1, 0, 0, 0, 0];
    const { slope } = plattScale(
      raw,
      labels,
      raw.map(() => 1),
    );
    expect(slope).toBeGreaterThan(0);
  });
});
