import { MARKET_LEARNER_FEATURE_NAMES } from "./features.js";
import { isCurrentLabelRule, runDoublings, runWeight, TEN_X_MULTIPLE } from "./labels.js";
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
  /**
   * What the trees were fitted to when it wasn't the win probability (see BoostingObjective);
   * their sum is then a learned ordering, mapped onto a probability scale by plattScale. Absent
   * = logistic.
   */
  objective?: Exclude<BoostingObjective, "logistic">;
  /** Set when the trees are a random forest (forest.ts) rather than a boosted sequence. */
  family?: "forest";
  /**
   * Set when the trees were fitted on top of a given log-odds (BoostingOptions.offsetInput): every
   * prediction starts from the candidate's own value of `input` instead of one shared rate, and
   * baseScore is `centre`, the training rows' mean of it (a missing value starts there). With no
   * trees the model scores exactly that input.
   */
  offset?: { input: string; centre: number };
}

/**
 * What a boosted forest is fitted to:
 *  - "logistic": the probability of a clean 2x (log loss) - the default.
 *  - "lambdarank": the ORDER of the tokens seen in the same hour, by how far each ran (a miss,
 *    2x, 4x, 10x). LambdaRank: pairwise logistic loss on every (better, worse) pair in the hour,
 *    each pair weighted by how much swapping them would move the hour's NDCG, truncated to pairs
 *    that touch the top of the hour's current ranking - so the fit spends itself on getting the
 *    top of each hour right, which is the only part of the ranking the feed ever acts on.
 *  - "runSize": how far a winner runs - its peak over the label window in doublings, any loss
 *    0 - by squared error. A model of the run, not just of the win: it ranks a likely 5x above a
 *    sure 2x.
 *  - "return": the call's return under the exit plan, in percent of the stake, capped at
 *    RETURN_TARGET_CAP_PCT - by squared error. The money a call makes, learned directly: no
 *    split into 2x and crash odds and no fixed payoffs, so a 2x that lands after the 15-minute
 *    win window, or a winner that runs further, counts for what it paid (returnTarget).
 *  - "payoff": whether the call made money under the exit plan (log loss), each row weighted by
 *    how much it made or lost (|returnTarget|, at least PAYOFF_MIN_WEIGHT_PCT). The optimum of a
 *    leaf is the money won's share of all the money moved there, so the score orders coins by
 *    profit factor (gross gains over gross losses) rather than by an average. A classifier's
 *    bounded gradient: one +500% runner moves a leaf like ten stop-outs, but never owns the fit
 *    the way it can a squared error (payoffWeights).
 * Any non-default objective leaves the tree sum on its own scale; trainBoostedCurator then
 * fits a one-dimensional logistic map from that sum to the clean-2x label (Platt scaling) and
 * folds it into the trees, so every stored model still scores as a probability of a clean 2x.
 */
export type BoostingObjective = "logistic" | "lambdarank" | "runSize" | "return" | "payoff";

/** Squared-error objectives: the trees fit a number per row (regressionTarget), not a class. */
const isRegression = (objective: BoostingObjective) => objective === "runSize" || objective === "return";

export interface BoostingRow {
  anchorAt: Date;
  features: Record<string, number | null | undefined>;
  labelValue: number;
  tokenId?: string;
  /** Same meaning as TrainingRow.labelRule in trainer.ts. */
  labelRule?: number;
  /** Same meaning as TrainingRow.runPeakMultiple in trainer.ts: weighs the row by how far it ran. */
  runPeakMultiple?: number;
  /** Same meaning as TrainingRow.hit10x: the "lambdarank" objective's top relevance tier. */
  hit10x?: boolean;
  /** Same meanings as on TrainingRow: the "return" and "payoff" objectives' target (returnTarget). */
  returnPct?: number;
  crashed?: boolean;
  survived?: boolean;
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
  /** What the trees fit - see BoostingObjective. Default "logistic". */
  objective?: BoostingObjective;
  /** Newest share of rows held out to choose the number of trees. */
  validationFraction?: number;
  /** Stop after this many trees without a validation improvement. */
  patience?: number;
  seed?: number;
  /**
   * Forests grown, each from its own seed, and averaged into the one shipped model (every tree
   * kept, its values scaled by 1/n). Row and feature sampling make a single forest's top picks
   * partly luck of the seed; the mean of a few is the same model with that luck averaged out.
   */
  bagSeeds?: number;
  /** Same meaning as TrainOptions.recencyHalfLifeDays in trainer.ts. */
  recencyHalfLifeDays?: number;
  /** Same meaning as TrainOptions.legacyLabelWeight in trainer.ts. */
  legacyLabelWeight?: number;
  /** Same meaning as TrainOptions.runWeightPerDoubling in trainer.ts. */
  runWeightPerDoubling?: number;
  /** The inputs the forest may split on - see TrainOptions.featureNames. Omitted = MARKET_LEARNER_FEATURE_NAMES. */
  featureNames?: readonly string[];
  /**
   * A feature holding a log-odds to start every row from (LightGBM's init_score), logistic
   * objective only. The trees then learn a correction to it, and early stopping may keep none:
   * a correction that doesn't beat the given log-odds on the held-out newest rows is not grown,
   * and with too few rows to hold out none is. See BoostedCuratorParams.offset.
   */
  offsetInput?: string;
}

/**
 * Small-data defaults. Depth 3 lets a tree express a three-way interaction ("young AND heavy buy
 * pressure AND few snipers") while staying far from memorizing tokens; 0.05 x a few hundred trees
 * is the usual slow-and-many trade; min 30 rows a leaf keeps every leaf a statistic.
 */
export const DEFAULT_BOOSTING_OPTIONS: ResolvedBoostingOptions = {
  maxTrees: 300,
  learningRate: 0.05,
  maxDepth: 3,
  minLeafRows: 30,
  minLeafHessian: 1,
  l2: 1,
  rowSample: 0.8,
  featureSample: 0.8,
  maxBins: 32,
  objective: "logistic",
  validationFraction: 0.2,
  patience: 30,
  seed: 1,
  // 3 since 2026-10-16 (user decision; was 1). Offline on 21.8k rows from 10-05: a 10-seed bag of
  // the default recipe picked the same top 20% hit rate as one forest (21.8% vs 21.3%, inside
  // noise) with a third less spread between exam slices; deeper trees, more trees, CatBoost and
  // other families did no better. Costs one forest's training time per seed.
  bagSeeds: 3,
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
export function prng(seed: number): () => number {
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
export function featureColumns(
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
export function binColumn(col: Float64Array, maxBins: number): { edges: number[]; bins: Uint8Array } {
  // A typed array and its native numeric sort rather than a number[] and a comparator: this runs
  // once per feature per fit, over every row, and the comparator call dominated it.
  let count = 0;
  let negatives = 0;
  for (const v of col) {
    if (Number.isNaN(v)) continue;
    count++;
    if (v < 0) negatives++;
  }
  const present = new Float64Array(count);
  let k = 0;
  for (const v of col) if (!Number.isNaN(v)) present[k++] = v;
  present.sort();
  const edges: number[] = [];
  if (present.length > 0) {
    for (let q = 1; q < maxBins; q++) {
      const idx = Math.min(present.length - 1, Math.floor((q * present.length) / maxBins));
      const v = present[idx]!;
      if (edges.length === 0 || v > edges[edges.length - 1]!) {
        // The native sort puts -0 before +0 where the comparator sort kept them in row order;
        // they bin the same, but take the zero the old sort would have so the stored threshold
        // is unchanged to the bit. The zeros start right after the negatives.
        edges.push(v === 0 ? nthZero(col, idx - negatives) : v);
      }
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

/** The nth (0-based) zero of the column in row order, keeping its sign. */
function nthZero(col: Float64Array, n: number): number {
  let seen = 0;
  for (const v of col) if (v === 0 && seen++ === n) return v;
  return 0;
}

interface Split {
  gain: number;
  feature: number;
  /** Rows with bin in 1..binCut go left. */
  binCut: number;
  missingLeft: boolean;
}

export type ResolvedBoostingOptions = Required<
  Omit<
    BoostingOptions,
    "recencyHalfLifeDays" | "legacyLabelWeight" | "runWeightPerDoubling" | "featureNames" | "offsetInput"
  >
>;

export interface GrowContext {
  bins: Uint8Array[];
  edges: number[][];
  grad: Float64Array;
  hess: Float64Array;
  opts: ResolvedBoostingOptions;
  features: number[];
  /**
   * What a node outputs, given its rows' gradient and hessian sums and the rows themselves.
   * Default: the Newton step the boosting takes (leafValue). A random forest (forest.ts) puts
   * the node's own smoothed win rate here instead.
   */
  nodeValue?: (g: number, h: number, rows: Uint32Array) => number;
  /** `bins` as one row-major block (rowMajorBins); built per tree when omitted. */
  rowBins?: Uint8Array;
}

function leafValue(g: number, h: number, ctx: GrowContext): number {
  return (-g / (h + ctx.opts.l2)) * ctx.opts.learningRate;
}

/**
 * Every row's bins in one row-major block (row i's bin for feature f at i * featureCount + f):
 * the split search's layout. Built once per fit; see bestSplit.
 */
export function rowMajorBins(bins: readonly Uint8Array[], rowCount: number): Uint8Array {
  const featureCount = bins.length;
  const out = new Uint8Array(rowCount * featureCount);
  for (let f = 0; f < featureCount; f++) {
    const col = bins[f]!;
    for (let i = 0; i < rowCount; i++) out[i * featureCount + f] = col[i]!;
  }
  return out;
}

/**
 * One histogram slot per (sampled feature, bin), reused by every node of a tree: the slot's
 * gradient sum, hessian sum and row count side by side (a count is a whole number, exact in a
 * double), so one row's update touches one cache line.
 */
interface SplitScratch {
  stride: number;
  hist: Float64Array;
  /** Each sampled feature's column in the row-major block. */
  columns: Int32Array;
}

/**
 * The best split of a node. Its histograms are built in one pass over the node's rows, every
 * sampled feature at once, reading each row's bins from the row-major block: model audit
 * 2026-10-27 (DB-2, MT-10) measured the split search at 77% of a fit when it walked the rows once
 * per feature through three fresh histograms. Each (feature, bin) slot still adds its rows in row
 * order, so every sum - and with it every split, threshold and leaf value - is unchanged to the
 * bit (boosting.test.ts pins a trained model's hash).
 */
function bestSplit(
  rows: Uint32Array,
  gSum: number,
  hSum: number,
  ctx: GrowContext,
  rowBins: Uint8Array,
  scratch: SplitScratch,
): Split | null {
  const { l2, minLeafRows, minLeafHessian } = ctx.opts;
  const parentScore = (gSum * gSum) / (hSum + l2);
  const n = rows.length;
  const { stride, hist, columns } = scratch;
  const nf = columns.length;
  // Every cut leaves one side under minLeafRows: no split, and no histogram needed to say so.
  if (n < 2 * minLeafRows || nf === 0) return null;
  const featureCount = ctx.bins.length;
  const grad = ctx.grad;
  const hess = ctx.hess;
  const width = 3 * stride;
  hist.fill(0);
  for (let k = 0; k < n; k++) {
    const i = rows[k]!;
    const gi = grad[i]!;
    const hi = hess[i]!;
    const base = i * featureCount;
    for (let j = 0, o = 0; j < nf; j++, o += width) {
      const slot = o + 3 * rowBins[base + columns[j]!]!;
      hist[slot] = hist[slot]! + gi;
      hist[slot + 1] = hist[slot + 1]! + hi;
      hist[slot + 2] = hist[slot + 2]! + 1;
    }
  }
  let best: Split | null = null;
  for (let j = 0; j < nf; j++) {
    const f = columns[j]!;
    const nb = ctx.edges[f]!.length + 2; // missing bin + edges.length + 1 value bins
    const o = j * width;
    const gMiss = hist[o]!;
    const hMiss = hist[o + 1]!;
    const cMiss = hist[o + 2]!;
    let gl = 0;
    let hl = 0;
    let cl = 0;
    // Cut after bin k: value bins 1..k left, k+1..nb-1 right, missing on whichever side is better.
    for (let k = 1; k < nb - 1; k++) {
      gl += hist[o + 3 * k]!;
      hl += hist[o + 3 * k + 1]!;
      cl += hist[o + 3 * k + 2]!;
      for (let side = 0; side < 2; side++) {
        const missLeft = side === 1;
        const gL = missLeft ? gl + gMiss : gl;
        const hL = missLeft ? hl + hMiss : hl;
        const cL = missLeft ? cl + cMiss : cl;
        const gR = gSum - gL;
        const hR = hSum - hL;
        const cR = n - cL;
        if (!(cL < minLeafRows || cR < minLeafRows || hL < minLeafHessian || hR < minLeafHessian)) {
          const gain = (gL * gL) / (hL + l2) + (gR * gR) / (hR + l2) - parentScore;
          if (gain > 1e-9 && (best === null || gain > best.gain)) {
            // No training row was missing here, so the gain can't say; a value missing live then
            // follows the heavier child rather than always reading as above the cut.
            best = { gain, feature: f, binCut: k, missingLeft: cMiss === 0 ? hL >= hR : missLeft };
          }
        }
        if (cMiss === 0) break; // both directions are the same split
      }
    }
  }
  return best;
}

export function growTree(rows: Uint32Array, ctx: GrowContext): BoostedTree {
  const tree: BoostedTree = { feature: [], threshold: [], missingLeft: [], left: [], right: [], value: [] };
  // A constant (or all-missing) column cannot split, so it is left out of the histograms.
  const splittable = ctx.features.filter((f) => ctx.edges[f]!.length > 0);
  let stride = 2;
  for (const f of splittable) stride = Math.max(stride, ctx.edges[f]!.length + 2);
  const scratch: SplitScratch = {
    stride,
    hist: new Float64Array(3 * stride * splittable.length),
    columns: Int32Array.from(splittable),
  };
  const rowBins = ctx.rowBins ?? rowMajorBins(ctx.bins, ctx.grad.length);
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
    tree.value.push(ctx.nodeValue ? ctx.nodeValue(g, h, nodeRows) : leafValue(g, h, ctx));
    if (depth >= ctx.opts.maxDepth) return id;
    const split = bestSplit(nodeRows, g, h, ctx, rowBins, scratch);
    if (split === null) return id;
    const bins = ctx.bins[split.feature]!;
    let leftCount = 0;
    for (const i of nodeRows) {
      const b = bins[i]!;
      if (b === 0 ? split.missingLeft : b <= split.binCut) leftCount++;
    }
    const leftRows = new Uint32Array(leftCount);
    const rightRows = new Uint32Array(nodeRows.length - leftCount);
    let l = 0;
    let r = 0;
    for (const i of nodeRows) {
      const b = bins[i]!;
      if (b === 0 ? split.missingLeft : b <= split.binCut) leftRows[l++] = i;
      else rightRows[r++] = i;
    }
    tree.feature[id] = split.feature;
    tree.threshold[id] = ctx.edges[split.feature]![split.binCut - 1]!;
    tree.missingLeft[id] = split.missingLeft ? 1 : 0;
    tree.left[id] = grow(leftRows, depth + 1);
    tree.right[id] = grow(rightRows, depth + 1);
    return id;
  };
  grow(rows, 0);
  return tree;
}

/** The leaf a (transformed, NaN-for-missing) vector lands in. */
export function leafOf(tree: BoostedTree, x: ArrayLike<number>): number {
  let node = 0;
  while (tree.feature[node]! >= 0) {
    const v = x[tree.feature[node]!]!;
    const goLeft = Number.isNaN(v) ? tree.missingLeft[node] === 1 : v <= tree.threshold[node]!;
    node = goLeft ? tree.left[node]! : tree.right[node]!;
  }
  return node;
}

/**
 * Per-row weights (run weight x recency decay x legacy-label discount - see rowWeight in
 * trainer.ts), mean 1.
 */
export function recencyWeights(
  rows: BoostingRow[],
  halfLifeDays: number | undefined,
  legacyLabelWeight: number | undefined,
  runWeightPerDoubling: number | undefined,
): Float64Array {
  const w = new Float64Array(rows.length).fill(1);
  if (rows.length === 0) return w;
  const decay = halfLifeDays !== undefined && halfLifeDays > 0;
  let newest = -Infinity;
  for (const r of rows) newest = Math.max(newest, r.anchorAt.getTime());
  const halfLifeMs = (halfLifeDays ?? 1) * 86_400_000;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let weight =
      runWeight(row, runWeightPerDoubling) *
      (decay ? 0.5 ** ((newest - row.anchorAt.getTime()) / halfLifeMs) : 1);
    if (legacyLabelWeight !== undefined && !isCurrentLabelRule(row)) {
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
 * A row's target under the "runSize" objective: a winner's run in doublings (runDoublings), any
 * loss 0, however high it peaked outside the win and whether or not it fell through the stop.
 * Until 2026-10-09 a loss counted its peak (a 1.9x, or a 5x after the 15-minute win window,
 * scored like a 2x or better), so Runner ranked late runners and near-misses above coins that
 * double in time (notes/runner-target-2026-10-09.md).
 * Until 2026-10-14 a stop-out counted -1. Fresh launches are the volatile ones: on decision rows
 * 10-05..10-13 under five minutes old, 79% fell through the stop and 19.5% doubled (mean target
 * -0.33), while coins three to six hours old stopped out 6% and doubled 1.9% (mean -0.03). So the
 * -1 taught Runner that a stagnant old coin which can no longer fall far beats a fresh launch
 * that doubles ten times as often, and it kept calling hours-old coins that had stopped moving
 * (84 of its 661 calls 10-12..10-14 were an hour or more old; 1 of 27 graded doubled). Counting a
 * stop-out 0: walk-forward on production rows, 6-hour blocks 10-10 00:00 to 10-13 18:00, AUC 0.56
 * to 0.68 (better on all 15 blocks), top 5% doubled 20.3% to 24.4%, 5x+ runners in the top 5%
 * 21 to 25, and no call on a coin an hour or more old (was 15 of 217)
 * (notes/runner-old-tokens-2026-10-14.md).
 */
function runSizeTarget(row: BoostingRow): number {
  return row.labelValue > 0 ? runDoublings(row) : 0;
}

/**
 * The "return" objective's cap (user decision 2026-10-17). On the rule-4 rows 10-07..10-17
 * replayed under EXIT_PLAN the biggest call paid +874% and the 99th percentile +445%: the cap
 * keeps a few such runners from owning the squared error while leaving almost every winner's
 * own size (notes/return-formula-2026-10-17).
 */
export const RETURN_TARGET_CAP_PCT = 500;
/** And its floor: the plan's worst outcome is the stop, booked at -50% (profitSim.ts). */
export const RETURN_TARGET_FLOOR_PCT = -50;

/**
 * A row's target under "return": its return under the exit plan, capped. A row without one (no
 * price to replay it from) counts the default payoff of its kind, as trainer.ts rowReturnPct
 * does: +100% a clean 2x, -50% a stop-out, 0 anything else.
 */
export function returnTarget(row: BoostingRow): number {
  const r =
    row.returnPct !== undefined && Number.isFinite(row.returnPct)
      ? row.returnPct
      : row.labelValue > 0
        ? 100
        : (row.crashed ?? (row.survived === undefined ? false : !row.survived))
          ? -50
          : 0;
  return Math.min(RETURN_TARGET_CAP_PCT, Math.max(RETURN_TARGET_FLOOR_PCT, r));
}

/**
 * The least a row weighs under "payoff", in return points: a call that closed near flat still
 * says which side of zero coins like it land on, at a fifth of a stop-out's say (the stop weighs 50).
 */
export const PAYOFF_MIN_WEIGHT_PCT = 10;

/** Whether a row made money under the exit plan - the "payoff" objective's label. */
export function payoffLabel(row: BoostingRow): number {
  return returnTarget(row) > 0 ? 1 : 0;
}

/**
 * The "payoff" objective's weights: the given ones (recency, legacy label) times the money each
 * row made or lost, rescaled to mean 1 so minLeafHessian keeps meaning "about this many rows".
 */
export function payoffWeights(rows: BoostingRow[], base: Float64Array): Float64Array {
  const w = new Float64Array(rows.length);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    w[i] = base[i]! * Math.max(PAYOFF_MIN_WEIGHT_PCT, Math.abs(returnTarget(rows[i]!)));
    sum += w[i]!;
  }
  if (!(sum > 0)) return base;
  for (let i = 0; i < w.length; i++) w[i] = (w[i]! * rows.length) / sum;
  return w;
}

function regressionTarget(objective: BoostingObjective): ((row: BoostingRow) => number) | null {
  return objective === "runSize" ? runSizeTarget : objective === "return" ? returnTarget : null;
}

const TEN_X_LABEL = Math.log2(TEN_X_MULTIPLE);

/** A row's relevance tier under "lambdarank": 0 a miss, 1 a 2x, 2 a 4x, 3 a 10x. */
function relevanceTier(row: BoostingRow): number {
  if (!(row.labelValue > 0)) return 0;
  if (row.hit10x === true || row.labelValue >= TEN_X_LABEL) return 3;
  return row.labelValue >= 2 ? 2 : 1;
}

/** Pairs are only formed between rows that touch the top of their hour's current ranking. */
const LAMBDARANK_TRUNCATION = 30;
const HOUR_MS = 3_600_000;

/** Rows grouped by the hour they were sampled in - the "query" a ranking objective orders within. */
function hourGroups(rows: BoostingRow[]): Uint32Array[] {
  const byHour = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const h = Math.floor(rows[i]!.anchorAt.getTime() / HOUR_MS);
    let g = byHour.get(h);
    if (!g) byHour.set(h, (g = []));
    g.push(i);
  }
  return [...byHour.values()].map((g) => Uint32Array.from(g));
}

const discount = (rank: number) => 1 / Math.log2(rank + 2);

/** A fixed scramble of a row index (Knuth's multiplicative hash), for order-free tie breaks. */
const tieKey = (i: number) => Math.imul(i + 1, 2654435761) >>> 0;

/**
 * The LambdaRank gradients for one group (see BoostingObjective). `gains` is 2^tier - 1 per row;
 * the group's rows are ranked by their current margin and each (better, worse) pair that reaches
 * into the top LAMBDARANK_TRUNCATION contributes its pairwise logistic gradient scaled by the NDCG
 * the swap is worth. Returns the group's NDCG under the current ranking (for early stopping).
 */
function lambdaRankGroup(
  group: Uint32Array,
  margin: Float64Array,
  gains: Float64Array,
  weights: Float64Array,
  grad: Float64Array | null,
  hess: Float64Array | null,
): number {
  // Ties (every row on the first tree, rows sharing leaves after) break on a scrambled index, not
  // the rows' time order: a stable sort would hand the top slots - and so all the pairs - to each
  // group's earliest rows.
  const order = Array.from(group).sort((a, b) => margin[b]! - margin[a]! || tieKey(a) - tieKey(b));
  const ideal = Array.from(group)
    .map((i) => gains[i]!)
    .sort((a, b) => b - a);
  let idcg = 0;
  for (let r = 0; r < ideal.length; r++) idcg += ideal[r]! * discount(r);
  if (idcg <= 0) return 1;
  let dcg = 0;
  for (let r = 0; r < order.length; r++) dcg += gains[order[r]!]! * discount(r);
  if (grad === null || hess === null) return dcg / idcg;
  const top = Math.min(order.length, LAMBDARANK_TRUNCATION);
  for (let ri = 0; ri < top; ri++) {
    const i = order[ri]!;
    for (let rj = ri + 1; rj < order.length; rj++) {
      const j = order[rj]!;
      if (gains[i] === gains[j]) continue;
      const delta = (Math.abs(gains[i]! - gains[j]!) * Math.abs(discount(ri) - discount(rj))) / idcg;
      const w = (delta * (weights[i]! + weights[j]!)) / 2;
      // hi is the better one of the pair; the loss is log(1 + exp(-(m_hi - m_lo))).
      const [hi, lo] = gains[i]! > gains[j]! ? [i, j] : [j, i];
      const rho = 1 / (1 + Math.exp(margin[hi]! - margin[lo]!));
      grad[hi] = grad[hi]! - rho * w;
      grad[lo] = grad[lo]! + rho * w;
      const curvature = Math.max(1e-6, rho * (1 - rho)) * w;
      hess[hi] = hess[hi]! + curvature;
      hess[lo] = hess[lo]! + curvature;
    }
  }
  return dcg / idcg;
}

/** A fit's binned inputs: per-feature bins and edges, and the same bins row-major. */
interface PreparedBins {
  binned: { edges: number[]; bins: Uint8Array }[];
  rowBins: Uint8Array;
  /** The validation rows' transformed inputs, one vector per row, when the fit has them. */
  validX?: number[][];
}

function prepareBins(rows: BoostingRow[], featureNames: string[], maxBins: number): PreparedBins {
  const binned = featureColumns(rows, featureNames, CURRENT_FEATURE_TRANSFORM).map((c) =>
    binColumn(c, maxBins),
  );
  return {
    binned,
    rowBins: rowMajorBins(
      binned.map((b) => b.bins),
      rows.length,
    ),
  };
}

function validVectors(valid: BoostingRow[], featureNames: string[]): number[][] {
  const cols = valid.length > 0 ? featureColumns(valid, featureNames, CURRENT_FEATURE_TRANSFORM) : [];
  return valid.map((_, i) => cols.map((c) => c[i]!));
}

/**
 * Grows the forest on `fit` rows, tracking the objective's own loss on `valid` rows after each
 * tree (weighted log loss, squared error, or one minus the mean hourly NDCG). Returns the trees
 * and how many of them gave the best validation loss (all of them when there is no validation set).
 */
async function boost(
  fit: BoostingRow[],
  valid: BoostingRow[],
  treeLimit: number,
  opts: ResolvedBoostingOptions,
  halfLifeDays: number | undefined,
  legacyLabelWeight: number | undefined,
  runWeightPerDoubling: number | undefined,
  featureNames: string[],
  offsetInput: string | undefined,
  prepared?: PreparedBins,
): Promise<{
  baseScore: number;
  trees: BoostedTree[];
  bestTrees: number;
  binned: { edges: number[]; bins: Uint8Array }[];
}> {
  const objective = opts.objective;
  const { binned, rowBins } = prepared ?? prepareBins(fit, featureNames, opts.maxBins);
  const binColumns = binned.map((b) => b.bins);
  const binEdges = binned.map((b) => b.edges);
  const payoff = objective === "payoff";
  const labelOf = (r: BoostingRow) => (payoff ? payoffLabel(r) : r.labelValue > 0 ? 1 : 0);
  const ys = Float64Array.from(fit, labelOf);
  // The ranking, return and payoff objectives already pay for how far each row ran; the run
  // weight would count that twice.
  const runWeight = objective === "lambdarank" || objective === "return" || payoff ? 0 : runWeightPerDoubling;
  const weightsOf = (rs: BoostingRow[]) => {
    const w = recencyWeights(rs, halfLifeDays, legacyLabelWeight, runWeight);
    return payoff ? payoffWeights(rs, w) : w;
  };
  const weights = weightsOf(fit);
  const target = regressionTarget(objective);
  const targets = target ? Float64Array.from(fit, target) : null;
  const gains = objective === "lambdarank" ? Float64Array.from(fit, (r) => 2 ** relevanceTier(r) - 1) : null;
  const groups = objective === "lambdarank" ? hourGroups(fit) : null;

  let wSum = 0;
  let wPos = 0;
  for (let i = 0; i < fit.length; i++) {
    wSum += weights[i]!;
    wPos += weights[i]! * (targets ? targets[i]! : ys[i]!);
  }
  let baseScore: number;
  if (isRegression(objective)) {
    baseScore = wPos / wSum;
  } else if (objective === "lambdarank") {
    baseScore = 0;
  } else {
    // Clamped so an all-loss (or all-win) slice still starts from a finite log-odds.
    const baseRate = Math.min(1 - 1e-4, Math.max(1e-4, wPos / wSum));
    baseScore = Math.log(baseRate / (1 - baseRate));
  }
  // A given starting log-odds per row (offsetInput): baseScore becomes its weighted mean over the
  // fitting rows, which is where a row without it starts.
  const offsetOf = (r: BoostingRow) => {
    const v = offsetInput === undefined ? undefined : r.features[offsetInput];
    return v === null || v === undefined || !Number.isFinite(v) ? NaN : v;
  };
  if (offsetInput !== undefined) {
    let oSum = 0;
    let oW = 0;
    for (let i = 0; i < fit.length; i++) {
      const v = offsetOf(fit[i]!);
      if (Number.isNaN(v)) continue;
      oSum += weights[i]! * v;
      oW += weights[i]!;
    }
    if (oW > 0) baseScore = oSum / oW;
  }
  const startOf = (r: BoostingRow) => {
    const v = offsetOf(r);
    return Number.isNaN(v) ? baseScore : v;
  };

  const margin = Float64Array.from(fit, startOf);
  const grad = new Float64Array(fit.length);
  const hess = new Float64Array(fit.length);

  const validX = prepared?.validX ?? validVectors(valid, featureNames);
  const validY = valid.map(labelOf);
  const validW = weightsOf(valid);
  const validTargets = target ? Float64Array.from(valid, target) : null;
  const validGains =
    objective === "lambdarank" ? Float64Array.from(valid, (r) => 2 ** relevanceTier(r) - 1) : null;
  const validGroups = objective === "lambdarank" ? hourGroups(valid) : null;
  const validMargin = Float64Array.from(valid, startOf);
  const validLogLoss = () => {
    let loss = 0;
    for (let i = 0; i < valid.length; i++) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(validMargin[i]!)));
      loss -= validW[i]! * (validY[i]! * Math.log(p) + (1 - validY[i]!) * Math.log(1 - p));
    }
    return loss;
  };

  const rand = prng(opts.seed);
  const trees: BoostedTree[] = [];
  // On a given log-odds, no trees at all is a candidate too: a tree must beat the start to be kept.
  let bestLoss = offsetInput !== undefined && valid.length > 0 ? validLogLoss() : Infinity;
  let bestTrees = 0;
  const allFeatures = featureNames.map((_, j) => j);

  for (let t = 0; t < treeLimit; t++) {
    if (t > 0 && t % YIELD_EVERY_TREES === 0) await yieldToEventLoop();
    if (groups && gains) {
      grad.fill(0);
      hess.fill(0);
      for (const g of groups) lambdaRankGroup(g, margin, gains, weights, grad, hess);
    } else if (targets) {
      for (let i = 0; i < fit.length; i++) {
        grad[i] = (margin[i]! - targets[i]!) * weights[i]!;
        hess[i] = weights[i]!;
      }
    } else {
      for (let i = 0; i < fit.length; i++) {
        const p = sigmoid(margin[i]!);
        grad[i] = (p - ys[i]!) * weights[i]!;
        hess[i] = Math.max(1e-6, p * (1 - p)) * weights[i]!;
      }
    }
    const sampled: number[] = [];
    for (let i = 0; i < fit.length; i++) if (rand() < opts.rowSample) sampled.push(i);
    const features = allFeatures.filter(() => rand() < opts.featureSample);
    const tree = growTree(Uint32Array.from(sampled), {
      bins: binColumns,
      edges: binEdges,
      rowBins,
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
    for (let i = 0; i < valid.length; i++) {
      validMargin[i] = validMargin[i]! + tree.value[leafOf(tree, validX[i]!)]!;
    }
    let loss = 0;
    if (validGroups && validGains) {
      let ndcg = 0;
      for (const g of validGroups) ndcg += lambdaRankGroup(g, validMargin, validGains, validW, null, null);
      loss = 1 - ndcg / Math.max(1, validGroups.length);
    } else if (validTargets) {
      for (let i = 0; i < valid.length; i++) loss += validW[i]! * (validMargin[i]! - validTargets[i]!) ** 2;
    } else {
      loss = validLogLoss();
    }
    if (loss < bestLoss - 1e-9) {
      bestLoss = loss;
      bestTrees = trees.length;
    } else if (trees.length - bestTrees >= opts.patience) {
      break;
    }
  }
  return { baseScore, trees, bestTrees, binned };
}

/**
 * Platt scaling: the one-dimensional logistic map (slope, intercept) from a model's raw score
 * to the clean-2x label, fitted by Newton's method on the given rows. Folded into a forest by
 * scaling every tree value by the slope and moving the base score, so the stored model scores
 * as a probability through the same sigmoid as every other one. The slope is floored just above
 * zero: a fit that came out anti-correlated must not have its ordering flipped.
 */
export function plattScale(
  raw: ArrayLike<number>,
  labels: ArrayLike<number>,
  weights: ArrayLike<number>,
): { slope: number; intercept: number } {
  const n = raw.length;
  // Centre the input so the two parameters are near-orthogonal and Newton converges in a few steps.
  let mean = 0;
  let wSum = 0;
  let wPos = 0;
  for (let i = 0; i < n; i++) {
    mean += weights[i]! * raw[i]!;
    wSum += weights[i]!;
    wPos += weights[i]! * labels[i]!;
  }
  mean = wSum > 0 ? mean / wSum : 0;
  // Start from "the score says nothing": a flat slope at the base rate's log-odds. Starting at
  // (1, 0) puts every row at 0.5 against a rate near 5%, and the first full step overshoots.
  const rate = wSum > 0 ? Math.min(1 - 1e-6, Math.max(1e-6, wPos / wSum)) : 0.5;
  let a = 0;
  let b = Math.log(rate / (1 - rate));
  const L2 = 1e-3;
  const loss = (sa: number, sb: number) => {
    let l = 0.5 * L2 * sa * sa;
    for (let i = 0; i < n; i++) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(sa * (raw[i]! - mean) + sb)));
      l -= weights[i]! * (labels[i]! * Math.log(p) + (1 - labels[i]!) * Math.log(1 - p));
    }
    return l;
  };
  let current = loss(a, b);
  for (let iter = 0; iter < 25; iter++) {
    let ga = L2 * a;
    let gb = 0;
    let haa = L2;
    let hab = 0;
    let hbb = 0;
    for (let i = 0; i < n; i++) {
      const x = raw[i]! - mean;
      const p = sigmoid(a * x + b);
      const e = (p - labels[i]!) * weights[i]!;
      const h = Math.max(1e-9, p * (1 - p)) * weights[i]!;
      ga += e * x;
      gb += e;
      haa += h * x * x;
      hab += h * x;
      hbb += h;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    // Step halving: a full Newton step on clustered or non-monotone scores can overshoot into a
    // huge (finite) slope; only a step that lowers the loss is taken.
    let step = 1;
    let next = loss(a - da, b - db);
    while (!(next <= current) && step > 1e-6) {
      step /= 2;
      next = loss(a - step * da, b - step * db);
    }
    if (!(next <= current)) break;
    a -= step * da;
    b -= step * db;
    const improvement = current - next;
    current = next;
    if ((Math.abs(step * da) < 1e-9 && Math.abs(step * db) < 1e-9) || improvement < 1e-12 * wSum) break;
  }
  if (!(a > 1e-3) || !Number.isFinite(a) || !Number.isFinite(b))
    return { slope: 1e-3, intercept: Number.isFinite(b) ? b : 0 };
  return { slope: a, intercept: b - a * mean };
}

/**
 * leafOf for a training row, read from its bins rather than its values: identical routing
 * (a bin k row has value <= edges[k-1] exactly when k <= binCut), without re-reading features.
 */
export function leafOfBinned(
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
 * All of that runs once per bagSeeds seed and the forests are averaged into one model.
 */
export async function trainBoostedCurator(
  rows: BoostingRow[],
  options: BoostingOptions = {},
): Promise<Omit<BoostedCuratorParams, "threshold">> {
  if (rows.length === 0) throw new Error("cannot train on zero rows");
  const opts = { ...DEFAULT_BOOSTING_OPTIONS, ...stripUndefined(options) };
  const featureNames = [...(options.featureNames ?? MARKET_LEARNER_FEATURE_NAMES)];
  const offsetInput = options.offsetInput;
  if (offsetInput !== undefined && opts.objective !== "logistic") {
    throw new Error("a starting log-odds (offsetInput) needs the logistic objective");
  }
  const sorted = [...rows].sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());

  const cut = Math.floor(sorted.length * (1 - opts.validationFraction));
  const valid = sorted.slice(cut);
  const validTokens = new Set(valid.flatMap((r) => (r.tokenId === undefined ? [] : [r.tokenId])));
  const fit = sorted.slice(0, cut).filter((r) => r.tokenId === undefined || !validTokens.has(r.tokenId));
  const validWins = valid.filter((r) => r.labelValue > 0).length;
  // Every bag bins the same two row sets the same way (only the seed differs), so each is binned
  // once and shared: a third of a 3-bag fit's input reading and binning, with identical bins.
  let fitBins: PreparedBins | undefined;
  let allBins: PreparedBins | undefined;

  const grow = async (seedOpts: ResolvedBoostingOptions) => {
    // On a given log-odds, too little data to hold out means no evidence the trees improve on it.
    let treeCount = offsetInput !== undefined ? 0 : FALLBACK_TREES;
    if (
      valid.length >= MIN_VALIDATION_ROWS &&
      validWins >= MIN_VALIDATION_WINS &&
      fit.length >= MIN_VALIDATION_ROWS
    ) {
      fitBins ??= {
        ...prepareBins(fit, featureNames, opts.maxBins),
        validX: validVectors(valid, featureNames),
      };
      const probe = await boost(
        fit,
        valid,
        opts.maxTrees,
        seedOpts,
        options.recencyHalfLifeDays,
        options.legacyLabelWeight,
        options.runWeightPerDoubling,
        featureNames,
        offsetInput,
        fitBins,
      );
      // At least a handful: a forest that "stops" at 1-2 trees is barely more than the base rate.
      // On a given log-odds that start is the point, so as few as none are kept.
      treeCount = offsetInput !== undefined ? probe.bestTrees : Math.max(10, probe.bestTrees);
    }
    allBins ??= prepareBins(sorted, featureNames, opts.maxBins);
    const final = await boost(
      sorted,
      [],
      treeCount,
      seedOpts,
      options.recencyHalfLifeDays,
      options.legacyLabelWeight,
      options.runWeightPerDoubling,
      featureNames,
      offsetInput,
      allBins,
    );
    return final;
  };
  const bags = Math.max(1, Math.round(opts.bagSeeds));
  const grown: Awaited<ReturnType<typeof grow>>[] = [];
  // Seeds far apart in mulberry32's input so the bags' row and feature draws share nothing.
  for (let b = 0; b < bags; b++) grown.push(await grow({ ...opts, seed: opts.seed + b * 7919 }));
  const final = grown[0]!;
  const k = 1 / bags;
  let baseScore = grown.reduce((sum, g) => sum + g.baseScore, 0) * k;
  let trees =
    bags === 1
      ? final.trees
      : grown.flatMap((g) => g.trees.map((t) => ({ ...t, value: t.value.map((v) => v * k) })));
  if (opts.objective !== "logistic") {
    // The sum of the trees is an ordering, not a log-odds: map it onto the clean-2x label. The
    // final fit already binned exactly these rows, so its bins are reused rather than rebuilt.
    const binned = final.binned;
    const raw = new Float64Array(sorted.length).fill(baseScore);
    for (const tree of trees) {
      for (let i = 0; i < sorted.length; i++) raw[i] = raw[i]! + tree.value[leafOfBinned(tree, binned, i)]!;
    }
    const labels = Float64Array.from(sorted, (r) => (r.labelValue > 0 ? 1 : 0));
    const weights = recencyWeights(sorted, options.recencyHalfLifeDays, options.legacyLabelWeight, 0);
    const { slope, intercept } = plattScale(raw, labels, weights);
    trees = trees.map((t) => ({ ...t, value: t.value.map((v) => v * slope) }));
    baseScore = baseScore * slope + intercept;
  }
  return {
    kind: BOOSTED_MODEL_KIND,
    featureNames,
    transform: CURRENT_FEATURE_TRANSFORM,
    baseScore,
    trees,
    ...(opts.objective !== "logistic" ? { objective: opts.objective } : {}),
    ...(offsetInput !== undefined ? { offset: { input: offsetInput, centre: baseScore } } : {}),
  };
}

/**
 * Several boosted models of the same inputs as one: the mean of their log-odds, as a single model
 * (every tree kept, its values scaled by 1/n), so it scores and explains through the same entry
 * points. Used to serve cross-fit fold models as they were measured (narrativeLed.ts).
 */
export function averageBoosted(
  models: readonly Omit<BoostedCuratorParams, "threshold">[],
): Omit<BoostedCuratorParams, "threshold"> {
  const first = models[0];
  if (first === undefined) throw new Error("nothing to average");
  for (const m of models) {
    if (
      m.featureNames.join("\u0000") !== first.featureNames.join("\u0000") ||
      JSON.stringify(m.transform) !== JSON.stringify(first.transform) ||
      m.objective !== undefined ||
      m.offset !== undefined ||
      m.family !== undefined
    ) {
      throw new Error("only plain boosted models of the same inputs can be averaged");
    }
  }
  const k = 1 / models.length;
  return {
    kind: BOOSTED_MODEL_KIND,
    featureNames: [...first.featureNames],
    transform: first.transform,
    baseScore: models.reduce((s, m) => s + m.baseScore, 0) * k,
    trees: models.flatMap((m) => m.trees.map((t) => ({ ...t, value: t.value.map((v) => v * k) }))),
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

/** How far this candidate's own starting log-odds sits from the model's centre (0 without one). */
function offsetShift(
  params: Pick<BoostedCuratorParams, "offset">,
  features: Record<string, number | null | undefined>,
): number {
  if (params.offset === undefined) return 0;
  const v = features[params.offset.input];
  return v === null || v === undefined || !Number.isFinite(v) ? 0 : v - params.offset.centre;
}

/** Predicted probability of a clean 2x-within-1-hour. */
export function scoreBoosted(
  params: Omit<BoostedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): number {
  const x = transformedVector(params, features);
  let z = params.baseScore + offsetShift(params, features);
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
  // A given starting log-odds is credited to its input, so the sum still reaches the score.
  if (params.offset !== undefined) out.set(params.offset.input, offsetShift(params, features));
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
