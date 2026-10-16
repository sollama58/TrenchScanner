import { describe, expect, it } from "vitest";
import {
  averageBoosted,
  binColumn,
  boostedContributions,
  scoreBoosted,
  trainBoostedCurator,
  type BoostingRow,
} from "./boosting.js";
import {
  modelRationale,
  scoreCandidateWithModel,
  topModelReasons,
  trainCurator,
  trainCuratorModel,
} from "./trainer.js";

const T0 = new Date("2026-08-01T00:00:00Z").getTime();

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

/**
 * An interaction no sum of one-feature effects can express: buy pressure only predicts a win
 * when the top 10 is NOT sniper-heavy, and predicts a loss when it is.
 */
function interactionRows(count: number, seed = 3): BoostingRow[] {
  const rand = rng(seed);
  const rows: BoostingRow[] = [];
  for (let i = 0; i < count; i++) {
    const buyRatio24h = 0.3 + rand() * 0.5;
    const snipers = rand() * 60;
    const strongBuy = buyRatio24h > 0.6;
    const clean = snipers < 30;
    const p = strongBuy === clean ? 0.7 : 0.05;
    rows.push({
      tokenId: `t${i}`,
      anchorAt: new Date(T0 + i * 60_000),
      features: { buyRatio24h, freshTop10WalletPct: snipers, ageMinutes: rand() * 300 },
      labelValue: rand() < p ? 1.5 : 0,
    });
  }
  return rows;
}

function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSum = 0;
  let pos = 0;
  idx.forEach((i, r) => {
    if (labels[i]! > 0) {
      rankSum += r + 1;
      pos += 1;
    }
  });
  const neg = labels.length - pos;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const asTraining = (rows: BoostingRow[]) =>
  rows.map((r) => ({ ...r, anchorPriceUsd: 1e-5, anchorMcapUsd: 50_000 }));

describe("trainBoostedCurator", () => {
  it("learns an interaction the logistic model cannot", async () => {
    const train = interactionRows(3000, 3);
    const test = interactionRows(1500, 99);
    const labels = test.map((r) => r.labelValue);
    const boosted = await trainBoostedCurator(train);
    const linear = await trainCurator(asTraining(train));
    const boostedAuc = auc(
      test.map((r) => scoreBoosted(boosted, r.features)),
      labels,
    );
    const linearAuc = auc(
      test.map((r) => scoreCandidateWithModel(linear, r.features)),
      labels,
    );
    expect(boostedAuc).toBeGreaterThan(0.8);
    expect(boostedAuc).toBeGreaterThan(linearAuc + 0.1);
  });

  it("finds nothing in pure noise", async () => {
    const rand = rng(11);
    const rows: BoostingRow[] = Array.from({ length: 2000 }, (_, i) => ({
      tokenId: `n${i}`,
      anchorAt: new Date(T0 + i * 60_000),
      features: { buyRatio24h: rand(), freshTop10WalletPct: rand() * 60, ageMinutes: rand() * 300 },
      labelValue: rand() < 0.1 ? 1 : 0,
    }));
    const params = await trainBoostedCurator(rows.slice(0, 1500));
    const held = rows.slice(1500);
    const a = auc(
      held.map((r) => scoreBoosted(params, r.features)),
      held.map((r) => r.labelValue),
    );
    expect(Math.abs(a - 0.5)).toBeLessThan(0.08);
    // Early stopping keeps the forest small when there is nothing to learn.
    expect(params.trees.length).toBeLessThan(60);
  });

  it("is deterministic and survives a JSON round trip", async () => {
    const rows = interactionRows(800, 5);
    const a = await trainBoostedCurator(rows);
    const b = await trainBoostedCurator(rows);
    expect(b).toEqual(a);
    const stored = JSON.parse(JSON.stringify({ ...a, threshold: 0.5 }));
    const probe = { buyRatio24h: 0.7, freshTop10WalletPct: 10, ageMinutes: 60 };
    expect(scoreCandidateWithModel(stored, probe)).toBeCloseTo(scoreBoosted(a, probe), 12);
  });

  it("routes missing values the way the data says", async () => {
    // Rows with no sniper reading win far more often than measured ones.
    const rand = rng(21);
    const rows: BoostingRow[] = Array.from({ length: 2000 }, (_, i) => {
      const missing = rand() < 0.3;
      return {
        tokenId: `m${i}`,
        anchorAt: new Date(T0 + i * 60_000),
        features: { freshTop10WalletPct: missing ? null : rand() * 60 },
        labelValue: rand() < (missing ? 0.6 : 0.05) ? 1 : 0,
      };
    });
    const params = await trainBoostedCurator(rows);
    expect(scoreBoosted(params, { freshTop10WalletPct: null })).toBeGreaterThan(0.4);
    expect(scoreBoosted(params, { freshTop10WalletPct: 20 })).toBeLessThan(0.15);
  });

  it("attributes a score to the features that moved it", async () => {
    const params = await trainBoostedCurator(interactionRows(3000, 3));
    const features = { buyRatio24h: 0.75, freshTop10WalletPct: 5, ageMinutes: 100 };
    const contributions = boostedContributions(params, features);
    const total = [...contributions.values()].reduce((s, v) => s + v, 0);
    const rootSum = params.trees.reduce((s, t) => s + t.value[0]!, 0);
    const p = scoreBoosted(params, features);
    expect(params.baseScore + rootSum + total).toBeCloseTo(Math.log(p / (1 - p)), 9);
    expect(topModelReasons({ ...params }, features).length).toBeGreaterThan(0);
  });

  it("explains a score both ways in plain words", async () => {
    // Snipers alone decide here: a clean holder list wins, a sniped one loses; age is noise.
    const rand = rng(9);
    const rows: BoostingRow[] = Array.from({ length: 2000 }, (_, i) => {
      const snipers = rand() * 60;
      return {
        tokenId: `r${i}`,
        anchorAt: new Date(T0 + i * 60_000),
        features: { freshTop10WalletPct: snipers, ageMinutes: rand() * 300 },
        labelValue: rand() < (snipers < 30 ? 0.6 : 0.05) ? 1 : 0,
      };
    });
    const params = await trainBoostedCurator(rows);
    const good = modelRationale({ ...params }, { freshTop10WalletPct: 5, ageMinutes: 100 });
    const bad = modelRationale({ ...params }, { freshTop10WalletPct: 50, ageMinutes: 100 });
    expect(good.for[0]).toBe("fresh-wallet snipers");
    expect(bad.against[0]).toBe("fresh-wallet snipers");
    expect(bad.for).not.toContain("fresh-wallet snipers");
    expect(good.for.length).toBeLessThanOrEqual(3);
  });

  it("is reachable through trainCuratorModel", async () => {
    const params = await trainCuratorModel(asTraining(interactionRows(600, 8)), { learner: "gbdt" });
    expect(params.kind).toBe("gbdt-v1");
  });
});

describe("binColumn", () => {
  /** The comparator-sort binning binColumn used before the typed-array sort, as the reference. */
  function binColumnReference(col: Float64Array, maxBins: number): { edges: number[]; bins: Uint8Array } {
    const present: number[] = [];
    for (const v of col) if (!Number.isNaN(v)) present.push(v);
    present.sort((a, b) => a - b);
    const edges: number[] = [];
    if (present.length > 0) {
      for (let q = 1; q < maxBins; q++) {
        const v = present[Math.min(present.length - 1, Math.floor((q * present.length) / maxBins))]!;
        if (edges.length === 0 || v > edges[edges.length - 1]!) edges.push(v);
      }
      if (edges.length > 0 && edges[edges.length - 1]! >= present[present.length - 1]!) edges.pop();
    }
    const bins = new Uint8Array(col.length);
    for (let i = 0; i < col.length; i++) {
      const v = col[i]!;
      if (Number.isNaN(v)) continue;
      let lo = 0;
      let hi = edges.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (edges[mid]! < v) lo = mid + 1;
        else hi = mid;
      }
      bins[i] = lo + 1;
    }
    return { edges, bins };
  }

  const bits = (xs: number[]) => Array.from(new BigUint64Array(Float64Array.from(xs).buffer), String);

  it("matches the comparator-sort binning bit for bit", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const length = Math.floor(rand() * 400);
      // Missing values, heavy ties, and both signed zeros in row order, around few or many values.
      const levels = 1 + Math.floor(rand() * 50);
      const col = Float64Array.from({ length }, () => {
        const r = rand();
        if (r < 0.15) return NaN;
        if (r < 0.25) return -0;
        if (r < 0.35) return 0;
        return Math.round((rand() - 0.5) * levels) / 3;
      });
      for (const maxBins of [2, 16, 64]) {
        const got = binColumn(col, maxBins);
        const want = binColumnReference(col, maxBins);
        expect(bits(got.edges)).toEqual(bits(want.edges));
        expect(Array.from(got.bins)).toEqual(Array.from(want.bins));
      }
    }
  });
});

describe("boosting from a given log-odds (offsetInput)", () => {
  /** The label follows `start` (a log-odds); `extra` lifts it on top when lift > 1. */
  function offsetRows(count: number, lift: number, seed: number): BoostingRow[] {
    const rand = rng(seed);
    return Array.from({ length: count }, (_, i) => {
      const start = -3 + rand() * 3;
      const extra = rand();
      const p = Math.min(0.95, (1 / (1 + Math.exp(-start))) * (extra > 0.7 ? lift : 1));
      return {
        tokenId: `t${i}`,
        anchorAt: new Date(T0 + i * 60_000),
        features: { start, extra, noise: rand() },
        labelValue: rand() < p ? 1 : 0,
      };
    });
  }
  const logit = (p: number) => Math.log(p / (1 - p));

  it("keeps no trees when nothing beats the start, and then scores exactly the start", async () => {
    const model = await trainBoostedCurator(offsetRows(3000, 1, 5), {
      featureNames: ["noise"],
      offsetInput: "start",
      maxDepth: 2,
      learningRate: 0.02,
      l2: 20,
      minLeafRows: 100,
    });
    expect(model.offset?.input).toBe("start");
    expect(model.trees).toHaveLength(0);
    for (const start of [-2.5, -1, 0]) {
      expect(scoreBoosted(model, { start, noise: 0.5 })).toBeCloseTo(1 / (1 + Math.exp(-start)), 12);
    }
    // A candidate without the start begins at the training rows' mean of it.
    expect(logit(scoreBoosted(model, { noise: 0.5 }))).toBeCloseTo(model.baseScore, 9);
  });

  it("learns the correction a real input carries, credited to the start and that input", async () => {
    const model = await trainBoostedCurator(offsetRows(3000, 3, 6), {
      featureNames: ["extra"],
      offsetInput: "start",
    });
    expect(model.trees.length).toBeGreaterThan(0);
    const lifted = scoreBoosted(model, { start: -1.5, extra: 0.9 });
    const flat = scoreBoosted(model, { start: -1.5, extra: 0.2 });
    expect(lifted).toBeGreaterThan(flat);
    const parts = boostedContributions(model, { start: -1.5, extra: 0.9 });
    expect(parts.get("start")).toBeCloseTo(-1.5 - model.offset!.centre, 12);
    const total = [...parts.values()].reduce((a, b) => a + b, 0);
    // Path attribution sums to the score less the model's start and the trees' root values.
    const roots = model.trees.reduce((a, t) => a + t.value[0]!, 0);
    expect(total).toBeCloseTo(logit(lifted) - model.baseScore - roots, 9);
  });

  it("with too few rows to hold out, keeps no trees rather than a fixed count", async () => {
    const model = await trainBoostedCurator(offsetRows(200, 3, 7), {
      featureNames: ["extra"],
      offsetInput: "start",
    });
    expect(model.trees).toHaveLength(0);
  });

  it("is refused for an objective other than logistic", async () => {
    await expect(
      trainBoostedCurator(offsetRows(300, 1, 8), {
        featureNames: ["extra"],
        offsetInput: "start",
        objective: "runSize",
      }),
    ).rejects.toThrow();
  });
});

describe("seed bagging", () => {
  it("ships the mean of one forest per seed, the first being the single-seed forest", async () => {
    const rows = interactionRows(800, 3);
    const one = await trainBoostedCurator(rows, { seed: 1, bagSeeds: 1 });
    const second = await trainBoostedCurator(rows, { seed: 1 + 7919, bagSeeds: 1 });
    const bagged = await trainBoostedCurator(rows, { seed: 1, bagSeeds: 2 });
    expect(bagged.trees.length).toBe(one.trees.length + second.trees.length);
    const logit = (p: number) => Math.log(p / (1 - p));
    for (const row of interactionRows(20, 9)) {
      expect(logit(scoreBoosted(bagged, row.features))).toBeCloseTo(
        (logit(scoreBoosted(one, row.features)) + logit(scoreBoosted(second, row.features))) / 2,
        9,
      );
    }
  });

  it("bags three seeds by default", async () => {
    const rows = interactionRows(800, 3);
    const [a, b, c] = await Promise.all(
      [1, 1 + 7919, 1 + 2 * 7919].map((seed) => trainBoostedCurator(rows, { seed, bagSeeds: 1 })),
    );
    const bagged = await trainBoostedCurator(rows);
    expect(bagged.trees.length).toBe(a!.trees.length + b!.trees.length + c!.trees.length);
  });
});

describe("averageBoosted", () => {
  it("scores the mean of the models' log-odds and explains as their mean", async () => {
    const a = await trainBoostedCurator(interactionRows(800, 3), { seed: 1 });
    const b = await trainBoostedCurator(interactionRows(800, 4), { seed: 2 });
    const mean = averageBoosted([a, b]);
    const logit = (p: number) => Math.log(p / (1 - p));
    for (const row of interactionRows(20, 9)) {
      expect(logit(scoreBoosted(mean, row.features))).toBeCloseTo(
        (logit(scoreBoosted(a, row.features)) + logit(scoreBoosted(b, row.features))) / 2,
        9,
      );
      const ca = boostedContributions(a, row.features);
      const cb = boostedContributions(b, row.features);
      for (const [name, v] of boostedContributions(mean, row.features)) {
        expect(v).toBeCloseTo(((ca.get(name) ?? 0) + (cb.get(name) ?? 0)) / 2, 9);
      }
    }
  });

  it("refuses models of different inputs", async () => {
    const a = await trainBoostedCurator(interactionRows(400, 3), { featureNames: ["buyRatio24h"] });
    const b = await trainBoostedCurator(interactionRows(400, 3), { featureNames: ["ageMinutes"] });
    expect(() => averageBoosted([a, b])).toThrow();
  });
});
