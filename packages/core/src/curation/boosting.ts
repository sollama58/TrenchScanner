import { CANDIDATE_FEATURE_NAMES } from "./features.js";
import { CURRENT_FEATURE_TRANSFORM, transformFeature, type FeatureTransform } from "./featureTransform.js";

/**
 * The second curator model family: gradient-boosted decision trees (logistic loss, second-order
 * leaf values, histogram splits, learned missing-value directions - the XGBoost/LightGBM recipe),
 * in plain TypeScript like the logistic model beside it.
 *
 * Why it exists. The logistic model can only add up one-feature effects: "high buy pressure is
 * good" and "lots of fresh-wallet snipers is bad" each move the score by a fixed amount, whatever
 * else is true. Trench outcomes are mostly interactions and thresholds - buy pressure means
 * something different at $15k than at $400k, and a sniper-heavy top 10 is fine until it isn't.
 * Shallow trees learn exactly those, and boosted trees are the strongest general-purpose learner
 * on small, noisy tabular data. They are also the family most able to overfit, so this one is
 * deliberately conservative: depth-3 trees, a slow learning rate, row and feature subsampling,
 * L2 on every leaf, a minimum leaf size, and the number of trees chosen by early stopping on the
 * newest slice of the training window (tokens kept out of both halves). It is never trusted on
 * its own say-so: the training job runs it through the same walk-forward exam as the logistic
 * model and ships whichever earns the better out-of-sample hit rate.
 *
 * Pure: rows in, params out, deterministic for a given seed.
 */

export const BOOSTED_MODEL_KIND = "gbdt-v1";

/**
 * One tree, as parallel arrays (compact JSON, no recursion to serialize). Node 0 is the root.
 * feature[i] is the split feature's index, or -1 for a leaf. A present value goes left when its
 * transformed value is <= threshold[i]; a missing one goes left when missingLeft[i] is 1.
 * value[i] is the node's output in log-odds (already scaled by the learning rate): a leaf's is its
 * prediction, an internal node's is what the tree would have predicted had it stopped there - the
 * difference along a path is how much each split moved this candidate (see boostedReasons).
 */
export interface BoostedTree {
  feature: number[];
  threshold: number[];
  missingLeft: number[];
  left: number[];
  right: number[];
  value: number[];
}

export interface BoostedCuratorParams {
  kind: typeof BOOSTED_MODEL_KIND;
  featureNames: string[];
  transform: FeatureTransform;
  /** Log-odds every prediction starts from: the (weighted) base win rate of the training rows. */
  baseScore: number;
  trees: BoostedTree[];
  /** Emit when predicted probability >= this - set by the training job from the hit-rate exam. */
  threshold: number;
}

export interface BoostingRow {
  anchorAt: Date;
  features: Record<string, number | null | undefined>;
  labelValue: number;
  tokenId?: string;
  /** Same meaning as TrainingRow.labelRule in trainer.ts. */
  labelRule?: number;
}

export interface BoostingOptions {
  /** Upper bound on trees; early stopping usually ends well before it. */
  maxTrees?: number;
  learningRate?: number;
  maxDepth?: number;
  /** A split may not leave fewer rows than this on either side. */
  minLeafRows?: number;
  /** ...nor less hessian (sum of p(1-p) x weight) - the "min_child_weight" guard. */
  minLeafHessian?: number;
  /** L2 penalty on leaf values. */
  l2?: number;
  /** Share of rows each tree sees. */
  rowSample?: number;
  /** Share of features each tree may split on. */
  featureSample?: number;
  /** Histogram resolution per feature (quantile bins), at most 255. */
  maxBins?: number;
  /** Newest share of rows held out to choose the number of trees. */
  validationFraction?: number;
  /** Stop after this many trees without a validation improvement. */
  patience?: number;
  seed?: number;
  /** Same meaning as TrainOptions.recencyHalfLifeDays in trainer.ts. */
  recencyHalfLifeDays?: number;
  /** Same meaning as TrainOptions.legacyLabelWeight in trainer.ts. */
  legacyLabelWeight?: number;
}

/**
 * Small-data defaults. Depth 3 lets a tree express a three-way interaction ("young AND heavy buy
 * pressure AND few snipers") while staying far from memorizing tokens; 0.05 x a few hundred trees
 * is the usual slow-and-many trade; min 30 rows a leaf keeps every leaf a statistic.
 */
export const DEFAULT_BOOSTING_OPTIONS: Required<
  Omit<BoostingOptions, "recencyHalfLifeDays" | "legacyLabelWeight">
> = {
  maxTrees: 300,
  learningRate: 0.05,
  maxDepth: 3,
  minLeafRows: 30,
  minLeafHessian: 1,
  l2: 1,
  rowSample: 0.8,
  featureSample: 0.8,
  maxBins: 32,
  validationFraction: 0.2,
  patience: 30,
  seed: 1,
};

/** Fewest validation rows (and validation wins) early stopping needs to mean anything. */
const MIN_VALIDATION_ROWS = 100;
const MIN_VALIDATION_WINS = 5;
/** Trees used when there is too little data to early-stop on. */
const FALLBACK_TREES = 100;
/** Trees grown between yields to the event loop - see the note in trainer.ts's gradient loop. */
const YIELD_EVERY_TREES = 5;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Deterministic PRNG (mulberry32) - the same rows and seed always grow the same forest. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Transformed feature matrix, column-major; NaN = missing. */
function featureColumns(
  rows: BoostingRow[],
  featureNames: string[],
  transform: FeatureTransform,
): Float64Array[] {
  return featureNames.map((name) => {
    const col = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!.features[name];
      col[i] =
        raw === null || raw === undefined || !Number.isFinite(raw)
          ? NaN
          : transformFeature(name, raw, transform);
    }
    return col;
  });
}

/**
 * Quantile bin edges over a column's present values (at most maxBins - 1 distinct edges), and
 * each row's bin: 0 = missing, k >= 1 = value <= edges[k-1] (and > edges[k-2]). A split "after
 * bin k" therefore means value <= edges[k-1], which is the threshold stored in the tree.
 */
function binColumn(col: Float64Array, maxBins: number): { edges: number[]; bins: Uint8Array } {
  const present: number[] = [];
  for (const v of col) if (!Number.isNaN(v)) present.push(v);
  present.sort((a, b) => a - b);
  const edges: number[] = [];
  if (present.length > 0) {
    for (let q = 1; q < maxBins; q++) {
      const v = present[Math.min(present.length - 1, Math.floor((q * present.length) / maxBins))]!;
      if (edges.length === 0 || v > edges[edges.length - 1]!) edges.push(v);
    }
    // The top edge never splits anything off (nothing is above the max), so drop an edge equal to
    // the max and let the last bin hold it.
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

interface Split {
  gain: number;
  feature: number;
  /** Rows with bin in 1..binCut go left. */
  binCut: number;
  missingLeft: boolean;
}

interface GrowContext {
  bins: Uint8Array[];
  edges: number[][];
  grad: Float64Array;
  hess: Float64Array;
  opts: Required<Omit<BoostingOptions, "recencyHalfLifeDays" | "legacyLabelWeight">>;
  features: number[];
}

function leafValue(g: number, h: number, ctx: GrowContext): number {
  return (-g / (h + ctx.opts.l2)) * ctx.opts.learningRate;
}

function bestSplit(rows: Uint32Array, gSum: number, hSum: number, ctx: GrowContext): Split | null {
  const { l2, minLeafRows, minLeafHessian } = ctx.opts;
  const parentScore = (gSum * gSum) / (hSum + l2);
  let best: Split | null = null;
  for (const f of ctx.features) {
    const nb = ctx.edges[f]!.length + 2; // missing bin + edges.length + 1 value bins
    if (nb <= 2) continue; // a constant (or all-missing) column cannot split
    const G = new Float64Array(nb);
    const H = new Float64Array(nb);
    const C = new Uint32Array(nb);
    const bins = ctx.bins[f]!;
    for (let k = 0; k < rows.length; k++) {
      const i = rows[k]!;
      const b = bins[i]!;
      G[b] = G[b]! + ctx.grad[i]!;
      H[b] = H[b]! + ctx.hess[i]!;
      C[b] = C[b]! + 1;
    }
    const gMiss = G[0]!;
    const hMiss = H[0]!;
    const cMiss = C[0]!;
    let gl = 0;
    let hl = 0;
    let cl = 0;
    // Cut after bin k: value bins 1..k left, k+1..nb-1 right, missing on whichever side is better.
    for (let k = 1; k < nb - 1; k++) {
      gl += G[k]!;
      hl += H[k]!;
      cl += C[k]!;
      for (const missLeft of [false, true]) {
        const gL = missLeft ? gl + gMiss : gl;
        const hL = missLeft ? hl + hMiss : hl;
        const cL = missLeft ? cl + cMiss : cl;
        const gR = gSum - gL;
        const hR = hSum - hL;
        const cR = rows.length - cL;
        if (cL < minLeafRows || cR < minLeafRows || hL < minLeafHessian || hR < minLeafHessian) continue;
        const gain = (gL * gL) / (hL + l2) + (gR * gR) / (hR + l2) - parentScore;
        if (gain > 1e-9 && (best === null || gain > best.gain)) {
          best = { gain, feature: f, binCut: k, missingLeft: missLeft };
        }
        if (cMiss === 0) break; // both directions are the same split
      }
    }
  }
  return best;
}

function growTree(rows: Uint32Array, ctx: GrowContext): BoostedTree {
  const tree: BoostedTree = { feature: [], threshold: [], missingLeft: [], left: [], right: [], value: [] };
  const grow = (nodeRows: Uint32Array, depth: number): number => {
    let g = 0;
    let h = 0;
    for (const i of nodeRows) {
      g += ctx.grad[i]!;
      h += ctx.hess[i]!;
    }
    const id = tree.feature.length;
    tree.feature.push(-1);
    tree.threshold.push(0);
    tree.missingLeft.push(0);
    tree.left.push(-1);
    tree.right.push(-1);
    tree.value.push(leafValue(g, h, ctx));
    if (depth >= ctx.opts.maxDepth) return id;
    const split = bestSplit(nodeRows, g, h, ctx);
    if (split === null) return id;
    const bins = ctx.bins[split.feature]!;
    const leftRows: number[] = [];
    const rightRows: number[] = [];
    for (const i of nodeRows) {
      const b = bins[i]!;
      const goLeft = b === 0 ? split.missingLeft : b <= split.binCut;
      (goLeft ? leftRows : rightRows).push(i);
    }
    tree.feature[id] = split.feature;
    tree.threshold[id] = ctx.edges[split.feature]![split.binCut - 1]!;
    tree.missingLeft[id] = split.missingLeft ? 1 : 0;
    tree.left[id] = grow(Uint32Array.from(leftRows), depth + 1);
    tree.right[id] = grow(Uint32Array.from(rightRows), depth + 1);
    return id;
  };
  grow(rows, 0);
  return tree;
}

/** The leaf a (transformed, NaN-for-missing) vector lands in. */
function leafOf(tree: BoostedTree, x: ArrayLike<number>): number {
  let node = 0;
  while (tree.feature[node]! >= 0) {
    const v = x[tree.feature[node]!]!;
    const goLeft = Number.isNaN(v) ? tree.missingLeft[node] === 1 : v <= tree.threshold[node]!;
    node = goLeft ? tree.left[node]! : tree.right[node]!;
  }
  return node;
}

/** Per-row weights (recency decay x legacy-label discount - see rowWeight in trainer.ts), mean 1. */
function recencyWeights(
  rows: BoostingRow[],
  halfLifeDays: number | undefined,
  legacyLabelWeight: number | undefined,
): Float64Array {
  const w = new Float64Array(rows.length).fill(1);
  if (rows.length === 0) return w;
  const decay = halfLifeDays !== undefined && halfLifeDays > 0;
  if (!decay && legacyLabelWeight === undefined) return w;
  let newest = -Infinity;
  for (const r of rows) newest = Math.max(newest, r.anchorAt.getTime());
  const halfLifeMs = (halfLifeDays ?? 1) * 86_400_000;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let weight = decay ? 0.5 ** ((newest - row.anchorAt.getTime()) / halfLifeMs) : 1;
    if (legacyLabelWeight !== undefined && row.labelRule !== undefined && row.labelRule < 2) {
      weight *= legacyLabelWeight;
    }
    w[i] = weight;
    sum += weight;
  }
  // Every row weighing nothing (an all-legacy slice with a legacy weight of 0): train on the rows
  // as they are rather than dividing by zero into NaN.
  if (!(sum > 0)) return w.fill(1);
  // Mean weight 1, so minLeafHessian means "about this many rows' worth" whatever the decay.
  for (let i = 0; i < w.length; i++) w[i] = (w[i]! * rows.length) / sum;
  return w;
}

/**
 * Grows the forest on `fit` rows, tracking weighted log loss on `valid` rows after each tree.
 * Returns the trees and how many of them gave the best validation loss (all of them when there
 * is no validation set).
 */
async function boost(
  fit: BoostingRow[],
  valid: BoostingRow[],
  treeLimit: number,
  opts: Required<Omit<BoostingOptions, "recencyHalfLifeDays" | "legacyLabelWeight">>,
  halfLifeDays: number | undefined,
  legacyLabelWeight: number | undefined,
  featureNames: string[],
): Promise<{ baseScore: number; trees: BoostedTree[]; bestTrees: number }> {
  const transform = CURRENT_FEATURE_TRANSFORM;
  const cols = featureColumns(fit, featureNames, transform);
  const binned = cols.map((c) => binColumn(c, opts.maxBins));
  const ys = Float64Array.from(fit, (r) => (r.labelValue > 0 ? 1 : 0));
  const weights = recencyWeights(fit, halfLifeDays, legacyLabelWeight);

  let wSum = 0;
  let wPos = 0;
  for (let i = 0; i < fit.length; i++) {
    wSum += weights[i]!;
    wPos += weights[i]! * ys[i]!;
  }
  // Clamped so an all-loss (or all-win) slice still starts from a finite log-odds.
  const baseRate = Math.min(1 - 1e-4, Math.max(1e-4, wPos / wSum));
  const baseScore = Math.log(baseRate / (1 - baseRate));

  const margin = new Float64Array(fit.length).fill(baseScore);
  const grad = new Float64Array(fit.length);
  const hess = new Float64Array(fit.length);

  const validCols = valid.length > 0 ? featureColumns(valid, featureNames, transform) : [];
  const validX = valid.map((_, i) => validCols.map((c) => c[i]!));
  const validY = valid.map((r) => (r.labelValue > 0 ? 1 : 0));
  const validW = recencyWeights(valid, halfLifeDays, legacyLabelWeight);
  const validMargin = new Float64Array(valid.length).fill(baseScore);

  const rand = prng(opts.seed);
  const trees: BoostedTree[] = [];
  let bestLoss = Infinity;
  let bestTrees = 0;
  const allFeatures = featureNames.map((_, j) => j);

  for (let t = 0; t < treeLimit; t++) {
    if (t > 0 && t % YIELD_EVERY_TREES === 0) await yieldToEventLoop();
    for (let i = 0; i < fit.length; i++) {
      const p = sigmoid(margin[i]!);
      grad[i] = (p - ys[i]!) * weights[i]!;
      hess[i] = Math.max(1e-6, p * (1 - p)) * weights[i]!;
    }
    const sampled: number[] = [];
    for (let i = 0; i < fit.length; i++) if (rand() < opts.rowSample) sampled.push(i);
    const features = allFeatures.filter(() => rand() < opts.featureSample);
    const tree = growTree(Uint32Array.from(sampled), {
      bins: binned.map((b) => b.bins),
      edges: binned.map((b) => b.edges),
      grad,
      hess,
      opts,
      features: features.length > 0 ? features : allFeatures,
    });
    trees.push(tree);
    for (let i = 0; i < fit.length; i++) {
      // Every row - not just the sampled ones - moves by the tree's prediction for it.
      margin[i] = margin[i]! + tree.value[leafOfBinned(tree, binned, i)]!;
    }

    if (valid.length === 0) {
      bestTrees = trees.length;
      continue;
    }
    let loss = 0;
    for (let i = 0; i < valid.length; i++) {
      validMargin[i] = validMargin[i]! + tree.value[leafOf(tree, validX[i]!)]!;
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(validMargin[i]!)));
      loss -= validW[i]! * (validY[i]! * Math.log(p) + (1 - validY[i]!) * Math.log(1 - p));
    }
    if (loss < bestLoss - 1e-9) {
      bestLoss = loss;
      bestTrees = trees.length;
    } else if (trees.length - bestTrees >= opts.patience) {
      break;
    }
  }
  return { baseScore, trees, bestTrees };
}

/**
 * leafOf for a training row, read from its bins rather than its values: identical routing
 * (a bin k row has value <= edges[k-1] exactly when k <= binCut), without re-reading features.
 */
function leafOfBinned(
  tree: BoostedTree,
  binned: { edges: number[]; bins: Uint8Array }[],
  row: number,
): number {
  let node = 0;
  while (tree.feature[node]! >= 0) {
    const f = tree.feature[node]!;
    const b = binned[f]!.bins[row]!;
    // Bin b holds values <= edges[b-1], and every threshold is one of the edges, so the row goes
    // left exactly when its bin's upper edge is <= the threshold. The top bin has no upper edge.
    const upper = binned[f]!.edges[b - 1];
    const goLeft =
      b === 0 ? tree.missingLeft[node] === 1 : upper !== undefined && upper <= tree.threshold[node]!;
    node = goLeft ? tree.left[node]! : tree.right[node]!;
  }
  return node;
}

/**
 * Trains the boosted model. The number of trees is chosen by early stopping: the newest
 * validationFraction of rows (by anchor time) is held out - and any token sampled there is kept
 * out of the fitting half, since hourly samples of one token are near-duplicates and would make
 * the holdout flatter the forest into growing too long. The forest is then refit on every row
 * with that many trees. With too little data to hold out, a fixed conservative count is used.
 */
export async function trainBoostedCurator(
  rows: BoostingRow[],
  options: BoostingOptions = {},
): Promise<Omit<BoostedCuratorParams, "threshold">> {
  if (rows.length === 0) throw new Error("cannot train on zero rows");
  const opts = { ...DEFAULT_BOOSTING_OPTIONS, ...stripUndefined(options) };
  const featureNames = [...CANDIDATE_FEATURE_NAMES];
  const sorted = [...rows].sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());

  const cut = Math.floor(sorted.length * (1 - opts.validationFraction));
  const valid = sorted.slice(cut);
  const validTokens = new Set(valid.flatMap((r) => (r.tokenId === undefined ? [] : [r.tokenId])));
  const fit = sorted.slice(0, cut).filter((r) => r.tokenId === undefined || !validTokens.has(r.tokenId));
  const validWins = valid.filter((r) => r.labelValue > 0).length;

  let treeCount = FALLBACK_TREES;
  if (
    valid.length >= MIN_VALIDATION_ROWS &&
    validWins >= MIN_VALIDATION_WINS &&
    fit.length >= MIN_VALIDATION_ROWS
  ) {
    const probe = await boost(
      fit,
      valid,
      opts.maxTrees,
      opts,
      options.recencyHalfLifeDays,
      options.legacyLabelWeight,
      featureNames,
    );
    // At least a handful: a forest that "stops" at 1-2 trees is barely more than the base rate.
    treeCount = Math.max(10, probe.bestTrees);
  }
  const final = await boost(
    sorted,
    [],
    treeCount,
    opts,
    options.recencyHalfLifeDays,
    options.legacyLabelWeight,
    featureNames,
  );
  return {
    kind: BOOSTED_MODEL_KIND,
    featureNames,
    transform: CURRENT_FEATURE_TRANSFORM,
    baseScore: final.baseScore,
    trees: final.trees,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function transformedVector(
  params: Pick<BoostedCuratorParams, "featureNames" | "transform">,
  features: Record<string, number | null | undefined>,
): number[] {
  return params.featureNames.map((name) => {
    const raw = features[name];
    return raw === null || raw === undefined || !Number.isFinite(raw)
      ? NaN
      : transformFeature(name, raw, params.transform);
  });
}

/** Predicted probability of a clean 2x-within-1-hour. */
export function scoreBoosted(
  params: Omit<BoostedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): number {
  const x = transformedVector(params, features);
  let z = params.baseScore;
  for (const tree of params.trees) z += tree.value[leafOf(tree, x)]!;
  return sigmoid(z);
}

/**
 * Per-feature contributions to this candidate's score (log-odds), by path attribution: walking
 * each tree from root to leaf, every split's change in node value is credited to the feature it
 * split on. The contributions sum exactly to (score - the forest's average starting point), so
 * they answer "what pushed this one up" the way the logistic weights do.
 */
export function boostedContributions(
  params: Omit<BoostedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): Map<string, number> {
  const x = transformedVector(params, features);
  const out = new Map<string, number>();
  for (const tree of params.trees) {
    let node = 0;
    while (tree.feature[node]! >= 0) {
      const f = tree.feature[node]!;
      const v = x[f]!;
      const goLeft = Number.isNaN(v) ? tree.missingLeft[node] === 1 : v <= tree.threshold[node]!;
      const next = goLeft ? tree.left[node]! : tree.right[node]!;
      const name = params.featureNames[f]!;
      out.set(name, (out.get(name) ?? 0) + tree.value[next]! - tree.value[node]!);
      node = next;
    }
  }
  return out;
}
