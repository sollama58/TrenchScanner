import { describe, expect, it } from "vitest";
import { BOOSTED_MODEL_KIND, boostedContributions, type BoostedCuratorParams } from "./boosting.js";
import { clockFeatureValues } from "./clockFeatures.js";
import { featureHealthReport } from "./featureReport.js";
import { LEARNER_FEATURE_NAMES, RETIRED_LEARNER_INPUTS } from "./features.js";
import { syntheticMarket } from "./syntheticMarket.js";
import {
  CURATOR_MODEL_KIND,
  scoreWinOdds,
  trainCuratorModel,
  type LogisticCuratorParams,
  type TrainingRow,
  type UnthresholdedCuratorParams,
} from "./trainer.js";

/**
 * Reliance of the next fit on minutesSinceFirstInBand ("time in the band"), measured before
 * that input is retired. bandDwellShare stays a learner input beside it. No production
 * decision rows or saved model params are in this environment, so this is the synthetic
 * market (syntheticMarket.ts): its "interactions" truth
 * already makes a young coin with a 5m volume burst more likely to win, and it does not mention
 * time-in-band. The clocks are stamped the way clockFeatureValues derives them.
 *
 * Two arms:
 *  - "equal": the coin has been inside the band for its whole life, so minutesSinceFirstInBand
 *    equals launch age and bandDwellShare is 1 on every row. The column is a second copy of youth.
 *  - "product": a token-stable share of life was spent in the band, so
 *    minutesSinceFirstInBand = bandDwellShare * launchAgeMinutes. Share does not enter the label.
 *
 * The logistic and a small tree seat are fit with the column and again without it. A large
 * holdout probability move means the refit still needed the column; a large weight or split
 * share means the seat uses it when it is offered. These numbers are not production AUC.
 */

const CLOCKS = ["launchAgeMinutes", "bandDwellShare", "minutesSinceFirstInBand"] as const;

/** The synthetic truth's own inputs, plus the three clocks. ageMinutes stays off the vector:
 *  the next fit reads launchAgeMinutes, and the stamp copies age into it. */
const WITH_DWELL = [
  "mcapUsd",
  "buyRatio1h",
  "freshTop10WalletPct",
  "hasTwitter",
  "priceChange1hPct",
  "volume5mUsd",
  "volume5mToMcapRatio",
  ...CLOCKS,
] as const;

const WITHOUT_DWELL = WITH_DWELL.filter((name) => name !== "minutesSinceFirstInBand");

const TREE_OPTIONS = {
  maxTrees: 60,
  bagSeeds: 1,
  patience: 8,
  minLeafRows: 25,
  learningRate: 0.08,
  seed: 3,
} as const;

function shareOf(tokenId: string): number {
  let h = 2166136261;
  for (let i = 0; i < tokenId.length; i++) h = Math.imul(h ^ tokenId.charCodeAt(i), 16777619);
  const u = (h >>> 0) / 4294967296;
  return 0.2 + 0.8 * u;
}

function stamp(rows: readonly TrainingRow[], mode: "equal" | "product"): TrainingRow[] {
  return rows.map((row) => {
    const age = row.features.ageMinutes;
    if (typeof age !== "number" || !Number.isFinite(age)) throw new Error("synthetic row has no age");
    const share = mode === "equal" ? 1 : shareOf(row.tokenId ?? "");
    const features: Record<string, number | null> = {
      ...row.features,
      ageSource: 1,
      minutesSinceFirstInBand: age * share,
    };
    const clock = clockFeatureValues(features);
    features.launchAgeMinutes = clock.launchAgeMinutes;
    features.bandDwellShare = clock.bandDwellShare;
    return { ...row, features };
  });
}

function splitHoldout(rows: readonly TrainingRow[]): { train: TrainingRow[]; holdout: TrainingRow[] } {
  const cut = Math.floor(rows.length * 0.75);
  return { train: rows.slice(0, cut), holdout: rows.slice(cut) };
}

function round(n: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function logisticWeights(
  params: Omit<LogisticCuratorParams, "threshold">,
): { name: string; weight: number; share: number }[] {
  const weights = params.featureNames.map((name, j) => ({ name, weight: params.weights[j]! }));
  const abs = weights.reduce((s, w) => s + Math.abs(w.weight), 0);
  return weights.map((w) => ({ ...w, share: abs > 0 ? Math.abs(w.weight) / abs : 0 }));
}

function splitUsage(
  params: Omit<BoostedCuratorParams, "threshold">,
): { name: string; splits: number; share: number }[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const tree of params.trees) {
    for (const feature of tree.feature) {
      if (feature < 0) continue;
      const name = params.featureNames[feature]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      total += 1;
    }
  }
  return params.featureNames.map((name) => {
    const splits = counts.get(name) ?? 0;
    return { name, splits, share: total > 0 ? splits / total : 0 };
  });
}

function meanAbsPush(
  params: Omit<BoostedCuratorParams, "threshold">,
  rows: readonly TrainingRow[],
): { name: string; push: number; share: number }[] {
  const sums = new Map<string, number>();
  for (const name of params.featureNames) sums.set(name, 0);
  for (const row of rows) {
    const credits = boostedContributions(params, row.features);
    for (const name of params.featureNames)
      sums.set(name, (sums.get(name) ?? 0) + Math.abs(credits.get(name) ?? 0));
  }
  const rowsN = Math.max(1, rows.length);
  const push = params.featureNames.map((name) => ({ name, push: (sums.get(name) ?? 0) / rowsN }));
  const abs = push.reduce((s, p) => s + p.push, 0);
  return push.map((p) => ({ ...p, share: abs > 0 ? p.push / abs : 0 }));
}

function predictionDelta(
  withModel: UnthresholdedCuratorParams,
  withoutModel: UnthresholdedCuratorParams,
  rows: readonly TrainingRow[],
): { mae: number; maxAbs: number; corr: number; topFifthOverlap: number } {
  const a = rows.map((r) => scoreWinOdds(withModel, r.features));
  const b = rows.map((r) => scoreWinOdds(withoutModel, r.features));
  let mae = 0;
  let maxAbs = 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    mae += d;
    if (d > maxAbs) maxAbs = d;
    meanA += a[i]!;
    meanB += b[i]!;
  }
  mae /= a.length;
  meanA /= a.length;
  meanB /= a.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const corr = denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : 1;
  const fifth = Math.max(1, Math.floor(rows.length / 5));
  const top = (scores: number[]) =>
    new Set(
      scores
        .map((p, i) => ({ p, i }))
        .sort((x, y) => y.p - x.p)
        .slice(0, fifth)
        .map((x) => x.i),
    );
  const topA = top(a);
  const topB = top(b);
  let both = 0;
  for (const i of topA) if (topB.has(i)) both += 1;
  return { mae, maxAbs, corr, topFifthOverlap: both / fifth };
}

function clockSlice<T extends { name: string }>(rows: T[]): T[] {
  return CLOCKS.map((name) => rows.find((r) => r.name === name)!);
}

describe("minutesSinceFirstInBand reliance, before any retirement", () => {
  it("is still a learner input, beside bandDwellShare", () => {
    expect(RETIRED_LEARNER_INPUTS.has("minutesSinceFirstInBand")).toBe(false);
    expect(LEARNER_FEATURE_NAMES).toContain("minutesSinceFirstInBand");
    expect(RETIRED_LEARNER_INPUTS.has("bandDwellShare")).toBe(false);
    expect(LEARNER_FEATURE_NAMES).toContain("bandDwellShare");
    // The mixed clock is already out of the next fit. This test does not put it back.
    expect(RETIRED_LEARNER_INPUTS.has("ageMinutes")).toBe(true);
  });

  it("measures logistic weight, tree split use, and the holdout move when the column is left out", async () => {
    const raw = syntheticMarket({
      tokens: 900,
      days: 24,
      truth: "interactions",
      seed: 21,
      signalScale: 1.15,
    });
    const report: Record<string, unknown> = {};

    for (const mode of ["equal", "product"] as const) {
      const rows = stamp(raw, mode);
      const { train, holdout } = splitHoldout(rows);
      expect(holdout.length).toBeGreaterThan(200);

      const health = featureHealthReport(rows, [...CLOCKS, "ageMinutes"]);
      const logisticWith = await trainCuratorModel(train, { learner: "logistic", featureNames: WITH_DWELL });
      const logisticWithout = await trainCuratorModel(train, {
        learner: "logistic",
        featureNames: WITHOUT_DWELL,
      });
      const treeWith = await trainCuratorModel(train, {
        learner: "gbdt",
        featureNames: WITH_DWELL,
        boosting: TREE_OPTIONS,
      });
      const treeWithout = await trainCuratorModel(train, {
        learner: "gbdt",
        featureNames: WITHOUT_DWELL,
        boosting: TREE_OPTIONS,
      });

      if (
        logisticWith.kind !== CURATOR_MODEL_KIND ||
        logisticWithout.kind !== CURATOR_MODEL_KIND ||
        treeWith.kind !== BOOSTED_MODEL_KIND ||
        treeWithout.kind !== BOOSTED_MODEL_KIND
      ) {
        throw new Error("expected a logistic and a boosted seat");
      }
      expect(logisticWith.featureNames).toContain("minutesSinceFirstInBand");
      expect(logisticWithout.featureNames).not.toContain("minutesSinceFirstInBand");
      expect(treeWith.featureNames).toContain("minutesSinceFirstInBand");
      expect(treeWithout.featureNames).not.toContain("minutesSinceFirstInBand");

      const logisticAll = logisticWeights(logisticWith);
      const splitsAll = splitUsage(treeWith);
      const pushAll = meanAbsPush(treeWith, holdout);
      const logistic = clockSlice(logisticAll);
      const splits = clockSlice(splitsAll);
      const push = clockSlice(pushAll);
      const logisticDelta = predictionDelta(logisticWith, logisticWithout, holdout);
      const treeDelta = predictionDelta(treeWith, treeWithout, holdout);
      const byShare = (rows: { name: string; share: number }[]) =>
        [...rows].sort((a, b) => b.share - a.share).slice(0, 5);

      report[mode] = {
        rows: rows.length,
        holdout: holdout.length,
        baseWinRatePct: health.baseWinRatePct,
        decileLift: health.features.map((f) => ({
          feature: f.feature,
          top: f.topDecileLift,
          bottom: f.bottomDecileLift,
          present: f.present,
        })),
        logisticWeightShare: logistic.map((w) => ({
          name: w.name,
          weight: round(w.weight),
          share: round(w.share),
        })),
        logisticTop: byShare(logisticAll).map((w) => ({ name: w.name, share: round(w.share) })),
        treeSplitShare: splits.map((s) => ({ name: s.name, splits: s.splits, share: round(s.share) })),
        treeSplitTop: byShare(splitsAll).map((s) => ({
          name: s.name,
          splits: splitsAll.find((row) => row.name === s.name)!.splits,
          share: round(s.share),
        })),
        treeHoldoutPushShare: push.map((p) => ({ name: p.name, share: round(p.share) })),
        logisticHoldout: {
          mae: round(logisticDelta.mae),
          maxAbs: round(logisticDelta.maxAbs),
          corr: round(logisticDelta.corr),
          topFifthOverlap: round(logisticDelta.topFifthOverlap),
        },
        treeHoldout: {
          mae: round(treeDelta.mae),
          maxAbs: round(treeDelta.maxAbs),
          corr: round(treeDelta.corr),
          topFifthOverlap: round(treeDelta.topFifthOverlap),
        },
      };

      for (const row of logistic) expect(Number.isFinite(row.weight)).toBe(true);
      expect(logisticDelta.mae).toBeGreaterThanOrEqual(0);
      expect(treeDelta.mae).toBeGreaterThanOrEqual(0);
      expect(logisticDelta.corr).toBeGreaterThan(0.9);
      expect(treeDelta.corr).toBeGreaterThan(0.9);
    }

    // A third arm, still on the same synthetic rows: the label is rewritten so a short time in
    // the band wins and a long one does not. launchAgeMinutes and bandDwellShare stay, and
    // dwell is their product. This is the case where the column is the label's own input, so
    // the refit has to rebuild it from the two clocks that remain. Not a production label.
    const plantedRows = stamp(raw, "product").map((row) => {
      const dwell = row.features.minutesSinceFirstInBand;
      if (typeof dwell !== "number") throw new Error("planted row has no dwell");
      return { ...row, labelValue: dwell < 45 ? 1.5 : 0 };
    });
    const plantedSplit = splitHoldout(plantedRows);
    const plantedWith = await trainCuratorModel(plantedSplit.train, {
      learner: "logistic",
      featureNames: WITH_DWELL,
    });
    const plantedWithout = await trainCuratorModel(plantedSplit.train, {
      learner: "logistic",
      featureNames: WITHOUT_DWELL,
    });
    const plantedTreeWith = await trainCuratorModel(plantedSplit.train, {
      learner: "gbdt",
      featureNames: WITH_DWELL,
      boosting: TREE_OPTIONS,
    });
    const plantedTreeWithout = await trainCuratorModel(plantedSplit.train, {
      learner: "gbdt",
      featureNames: WITHOUT_DWELL,
      boosting: TREE_OPTIONS,
    });
    if (plantedWith.kind !== CURATOR_MODEL_KIND || plantedTreeWith.kind !== BOOSTED_MODEL_KIND) {
      throw new Error("expected a logistic and a boosted seat");
    }
    const plantedLogistic = clockSlice(logisticWeights(plantedWith));
    const plantedSplits = clockSlice(splitUsage(plantedTreeWith));
    const plantedLogisticDelta = predictionDelta(plantedWith, plantedWithout, plantedSplit.holdout);
    const plantedTreeDelta = predictionDelta(plantedTreeWith, plantedTreeWithout, plantedSplit.holdout);
    report.planted = {
      logisticWeightShare: plantedLogistic.map((w) => ({
        name: w.name,
        weight: round(w.weight),
        share: round(w.share),
      })),
      treeSplitShare: plantedSplits.map((s) => ({ name: s.name, splits: s.splits, share: round(s.share) })),
      logisticHoldout: {
        mae: round(plantedLogisticDelta.mae),
        corr: round(plantedLogisticDelta.corr),
        topFifthOverlap: round(plantedLogisticDelta.topFifthOverlap),
      },
      treeHoldout: {
        mae: round(plantedTreeDelta.mae),
        corr: round(plantedTreeDelta.corr),
        topFifthOverlap: round(plantedTreeDelta.topFifthOverlap),
      },
    };

    // Printed so the measured reliance is in the test log. Not a production figure.
    console.log(`BAND_CLOCK_RELIANCE ${JSON.stringify(report)}`);

    const product = report.product as {
      logisticWeightShare: { name: string; share: number }[];
      treeSplitShare: { name: string; splits: number; share: number }[];
      logisticHoldout: { mae: number; topFifthOverlap: number };
      treeHoldout: { mae: number; topFifthOverlap: number };
    };
    const equal = report.equal as typeof product;
    const dwellOf = (arm: typeof product) =>
      arm.logisticWeightShare.find((w) => w.name === "minutesSinceFirstInBand")!;
    const splitsOf = (arm: typeof product) =>
      arm.treeSplitShare.find((w) => w.name === "minutesSinceFirstInBand")!;
    // Slack around the measured fit, not a production claim. On this market the column is at
    // most a few percent of logistic |weight| and of tree splits, and leaving it out of a refit
    // leaves the holdout ranking in place. A later change that makes either seat spend a large
    // share of itself on the column, or moves the holdout when the column is dropped, fails here.
    for (const arm of [equal, product]) {
      expect(dwellOf(arm).share).toBeLessThan(0.08);
      expect(splitsOf(arm).share).toBeLessThan(0.15);
      expect(arm.logisticHoldout.mae).toBeLessThan(0.01);
      expect(arm.logisticHoldout.topFifthOverlap).toBeGreaterThan(0.95);
      expect(arm.treeHoldout.mae).toBeLessThan(0.05);
      expect(arm.treeHoldout.topFifthOverlap).toBeGreaterThan(0.8);
    }

    const planted = report.planted as {
      logisticWeightShare: { name: string; share: number }[];
      treeSplitShare: { name: string; share: number }[];
      logisticHoldout: { mae: number; topFifthOverlap: number };
      treeHoldout: { mae: number; topFifthOverlap: number };
    };
    const plantedDwellWeight = planted.logisticWeightShare.find((w) => w.name === "minutesSinceFirstInBand")!;
    const plantedAgeWeight = planted.logisticWeightShare.find((w) => w.name === "launchAgeMinutes")!;
    const plantedDwellSplits = planted.treeSplitShare.find((w) => w.name === "minutesSinceFirstInBand")!;
    // When the label is the column, both seats lean on it, and the tree's top fifth moves
    // once a refit has to rebuild the product from launch age and band dwell share.
    expect(plantedDwellWeight.share).toBeGreaterThan(plantedAgeWeight.share);
    expect(plantedDwellWeight.share).toBeGreaterThan(0.3);
    expect(plantedDwellSplits.share).toBeGreaterThan(0.4);
    expect(planted.logisticHoldout.topFifthOverlap).toBeGreaterThan(0.9);
    expect(planted.treeHoldout.topFifthOverlap).toBeLessThan(0.85);
    expect(planted.treeHoldout.mae).toBeGreaterThan(0.04);
  }, 120_000);
});
