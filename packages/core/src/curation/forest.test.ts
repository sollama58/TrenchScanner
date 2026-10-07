import { describe, expect, it } from "vitest";
import { boostedContributions, scoreBoosted, trainBoostedCurator, type BoostingRow } from "./boosting.js";
import { DEFAULT_FOREST_OPTIONS, trainForestCurator } from "./forest.js";
import { scoreCandidateWithModel, trainCurator, trainCuratorModel } from "./trainer.js";

const T0 = new Date("2026-08-01T00:00:00Z").getTime();

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

/** The boosting test's interaction: buy pressure wins only when the top 10 is not sniper-heavy. */
function interactionRows(count: number, seed = 3): BoostingRow[] {
  const rand = rng(seed);
  const rows: BoostingRow[] = [];
  for (let i = 0; i < count; i++) {
    const buyRatio24h = 0.3 + rand() * 0.5;
    const snipers = rand() * 60;
    const p = buyRatio24h > 0.6 === snipers < 30 ? 0.7 : 0.05;
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

const asTraining = (rows: BoostingRow[]) =>
  rows.map((r) => ({ ...r, anchorPriceUsd: 1e-5, anchorMcapUsd: 50_000 }));

describe("trainForestCurator", () => {
  it("learns the interaction the logistic model cannot, and keeps up with the boosted trees", async () => {
    const train = interactionRows(3000, 3);
    const test = interactionRows(1500, 99);
    const labels = test.map((r) => r.labelValue);
    // Three features only: a tree shown 30% of them would see one, so let these see most.
    const forest = await trainForestCurator(train, { featureSample: 0.8 });
    const boosted = await trainBoostedCurator(train);
    const logistic = await trainCurator(asTraining(train), {
      featureNames: ["buyRatio24h", "freshTop10WalletPct", "ageMinutes"],
    });
    const forestAuc = auc(
      test.map((r) => scoreBoosted(forest, r.features)),
      labels,
    );
    const boostedAuc = auc(
      test.map((r) => scoreBoosted(boosted, r.features)),
      labels,
    );
    const logisticAuc = auc(
      test.map((r) => scoreCandidateWithModel(logistic, r.features)),
      labels,
    );
    expect(forestAuc).toBeGreaterThan(0.8);
    expect(forestAuc).toBeGreaterThan(logisticAuc + 0.2);
    expect(Math.abs(forestAuc - boostedAuc)).toBeLessThan(0.05);
  });

  it("is a bounded, deterministic forest stored in the boosted shape, and survives JSON", async () => {
    const train = interactionRows(1200, 5);
    const a = await trainForestCurator(train, { trees: 20, maxDepth: 4, seed: 7 });
    const b = await trainForestCurator(train, { trees: 20, maxDepth: 4, seed: 7 });
    expect(a).toEqual(b);
    expect(a.kind).toBe("gbdt-v1");
    expect(a.family).toBe("forest");
    expect(a.trees).toHaveLength(20);
    // A depth-4 tree has at most 31 nodes.
    for (const t of a.trees) expect(t.feature.length).toBeLessThanOrEqual(31);
    const copy = JSON.parse(JSON.stringify(a));
    const f = train[7]!.features;
    expect(scoreBoosted(copy, f)).toBe(scoreBoosted(a, f));
    expect(scoreBoosted(a, f)).toBeGreaterThan(0);
    expect(scoreBoosted(a, f)).toBeLessThan(1);
    expect(DEFAULT_FOREST_OPTIONS.trees).toBe(60);
  });

  it("attributes a score to the features that moved it, summing to the vote over the base rate", async () => {
    const train = interactionRows(1500, 11);
    const forest = await trainForestCurator(train, { trees: 10, maxDepth: 5, featureSample: 1 });
    const f = { buyRatio24h: 0.75, freshTop10WalletPct: 5, ageMinutes: 40 };
    // Every tree's value is already its share of the average (1/trees), so the sum is the mean vote.
    const contributions = boostedContributions(forest, f);
    const total = [...contributions.values()].reduce((s, v) => s + v, 0);
    const logit = Math.log(scoreBoosted(forest, f) / (1 - scoreBoosted(forest, f)));
    // Path attribution sums to score minus the root votes; the roots' votes are near zero (the
    // sampled base rate), so the gap is small.
    expect(Math.abs(logit - forest.baseScore - total)).toBeLessThan(0.5);
    expect(contributions.get("buyRatio24h")! + contributions.get("freshTop10WalletPct")!).toBeGreaterThan(
      0.5,
    );
  });

  it("is reachable through trainCuratorModel as the forest learner", async () => {
    const rows = asTraining(interactionRows(800, 2));
    const params = await trainCuratorModel(rows, { learner: "forest", forest: { trees: 8, maxDepth: 3 } });
    expect(params.kind).toBe("gbdt-v1");
    expect((params as { family?: string }).family).toBe("forest");
    expect((params as { trees: unknown[] }).trees).toHaveLength(8);
  });
});
