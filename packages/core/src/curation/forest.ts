import {
  binColumn,
  BOOSTED_MODEL_KIND,
  DEFAULT_BOOSTING_OPTIONS,
  featureColumns,
  growTree,
  prng,
  recencyWeights,
  type BoostedCuratorParams,
  type BoostedTree,
  type BoostingRow,
  type ResolvedBoostingOptions,
} from "./boosting.js";
import { CURRENT_FEATURE_TRANSFORM } from "./featureTransform.js";
import { LEARNER_FEATURE_NAMES } from "./features.js";

/**
 * The third learner family: a random forest. Deep trees, each grown on its own random slice of
 * the rows and allowed to split only on a random third of the features, their votes averaged.
 *
 * Why beside the boosted trees. Boosting grows shallow trees one after another, each correcting
 * the last, so the forest it ends with is one tightly coupled model; a random forest grows deep
 * trees independently and averages them, so its errors are the average of many loosely related
 * guesses. The two read the same rows and reach different rankings (rank correlation ~0.92 on
 * 2026-10-03..07 decision rows), and the forest was the steadier of the two at the tight end of
 * the ranking - the top 3% of decision moments, where the feed's calls come from - on that same
 * walk-forward replay. A different bias at the same cost is what the combiners feed on.
 *
 * Stored as a BOOSTED_MODEL_KIND params blob: each node's value is its smoothed win rate in
 * log-odds over the base rate, divided by the tree count, so the usual sum over trees IS the
 * average vote, and scoring, path attribution (boostedContributions) and the Models tab need no
 * new case. `family: "forest"` marks it.
 *
 * Pure: rows in, params out, deterministic for a given seed.
 */

export interface ForestOptions {
  /** Trees in the forest. */
  trees?: number;
  maxDepth?: number;
  /** A split may not leave fewer rows than this on either side. */
  minLeafRows?: number;
  /** Share of rows each tree sees (drawn without replacement). */
  rowSample?: number;
  /** Share of features each tree may split on. */
  featureSample?: number;
  /** Pseudo-rows at the base rate added to every node's win rate - a leaf of 25 rows is still a statistic. */
  smoothing?: number;
  maxBins?: number;
  seed?: number;
  /** Same meaning as BoostingOptions.recencyHalfLifeDays. */
  recencyHalfLifeDays?: number;
  legacyLabelWeight?: number;
  runWeightPerDoubling?: number;
  /** The inputs the forest may split on. Omitted = LEARNER_FEATURE_NAMES. */
  featureNames?: readonly string[];
}

/**
 * Sixty trees of depth six on 30% of the features each: on the 2026-10-03..07 replay that was as
 * good as deeper or larger forests at the top of the ranking, and it keeps a stored model near
 * the boosted ones' size (a depth-6 tree is at most 127 nodes).
 */
export const DEFAULT_FOREST_OPTIONS: Required<
  Omit<ForestOptions, "recencyHalfLifeDays" | "legacyLabelWeight" | "runWeightPerDoubling" | "featureNames">
> = {
  trees: 60,
  maxDepth: 6,
  minLeafRows: 25,
  rowSample: 0.63,
  featureSample: 0.3,
  smoothing: 5,
  maxBins: 32,
  seed: 1,
};

/** Trees grown between yields to the event loop (deep trees cost more than boosting's shallow ones). */
const YIELD_EVERY_TREES = 2;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const logit = (p: number) => Math.log(p / (1 - p));

export async function trainForestCurator(
  rows: BoostingRow[],
  options: ForestOptions = {},
): Promise<Omit<BoostedCuratorParams, "threshold">> {
  if (rows.length === 0) throw new Error("cannot train on zero rows");
  const opts = { ...DEFAULT_FOREST_OPTIONS, ...stripUndefined(options) };
  const featureNames = [...(options.featureNames ?? LEARNER_FEATURE_NAMES)];
  const transform = CURRENT_FEATURE_TRANSFORM;
  const cols = featureColumns(rows, featureNames, transform);
  const binned = cols.map((c) => binColumn(c, opts.maxBins));
  const ys = Float64Array.from(rows, (r) => (r.labelValue > 0 ? 1 : 0));
  const weights = recencyWeights(
    rows,
    options.recencyHalfLifeDays,
    options.legacyLabelWeight,
    options.runWeightPerDoubling,
  );

  let wSum = 0;
  let wPos = 0;
  for (let i = 0; i < rows.length; i++) {
    wSum += weights[i]!;
    wPos += weights[i]! * ys[i]!;
  }
  const baseRate = Math.min(1 - 1e-4, Math.max(1e-4, wPos / wSum));
  const baseScore = logit(baseRate);

  // Splits are scored as one Newton step from the base rate (the same gain boosting uses on its
  // first tree): a weighted variance reduction on the label, which is the random-forest criterion.
  const grad = new Float64Array(rows.length);
  const hess = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    grad[i] = (baseRate - ys[i]!) * weights[i]!;
    hess[i] = baseRate * (1 - baseRate) * weights[i]!;
  }
  const wy = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) wy[i] = weights[i]! * ys[i]!;

  const growOpts: ResolvedBoostingOptions = {
    ...DEFAULT_BOOSTING_OPTIONS,
    maxDepth: opts.maxDepth,
    minLeafRows: opts.minLeafRows,
    // A row's hessian is ~baseRate x (1 - baseRate), so this is minLeafRows' worth of hessian.
    minLeafHessian: opts.minLeafRows * baseRate * (1 - baseRate) * 0.5,
    l2: opts.smoothing,
    learningRate: 1,
    rowSample: opts.rowSample,
    featureSample: opts.featureSample,
    maxBins: opts.maxBins,
    maxTrees: opts.trees,
    seed: opts.seed,
  };
  const share = 1 / opts.trees;
  // A node's vote: its smoothed win rate as log-odds over the base rate, scaled to its share of
  // the average. Internal nodes carry it too, so path attribution reads the forest like a forest.
  const nodeValue = (_g: number, _h: number, nodeRows: Uint32Array): number => {
    let w = 0;
    let win = 0;
    for (const i of nodeRows) {
      w += weights[i]!;
      win += wy[i]!;
    }
    const rate = (win + opts.smoothing * baseRate) / (w + opts.smoothing);
    return (logit(Math.min(1 - 1e-4, Math.max(1e-4, rate))) - baseScore) * share;
  };

  const rand = prng(opts.seed);
  const allFeatures = featureNames.map((_, j) => j);
  const trees: BoostedTree[] = [];
  for (let t = 0; t < opts.trees; t++) {
    if (t > 0 && t % YIELD_EVERY_TREES === 0) await yieldToEventLoop();
    const sampled: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rand() < opts.rowSample) sampled.push(i);
    const features = allFeatures.filter(() => rand() < opts.featureSample);
    trees.push(
      growTree(Uint32Array.from(sampled), {
        bins: binned.map((b) => b.bins),
        edges: binned.map((b) => b.edges),
        grad,
        hess,
        opts: growOpts,
        features: features.length > 0 ? features : allFeatures,
        nodeValue,
      }),
    );
  }
  return { kind: BOOSTED_MODEL_KIND, featureNames, transform, baseScore, trees, family: "forest" };
}
