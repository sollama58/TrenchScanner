import { CANDIDATE_FEATURE_NAMES, FRIENDLY_FEATURE_LABELS, scoredFromFeatures } from "./features.js";
import { curationRankScore, evaluateCandidateHeuristic, inMcapBand, type McapBand } from "./curator.js";

/**
 * The self-learning half of Curated Alerts: a weighted logistic regression trained on the
 * CandidateOutcome labels, in plain TypeScript on purpose. At this data scale (thousands of
 * rows, ~50 dimensions) a regularized linear model is the honest tool: it can't overfit its way
 * to an impressive backtest the way a deep model can, its weights are inspectable (they power
 * the "reasons" on model-emitted alerts), and it needs no native dependencies the worker doesn't
 * already have.
 *
 * Everything here is pure - rows in, params out - so the whole training/evaluation/promotion
 * path is unit-testable without a database. The periodic training job
 * (apps/worker/src/jobs/curatorTrainingJob.ts) owns the IO.
 */

export interface TrainingRow {
  anchorAt: Date;
  /** The stored feature vector (CandidateOutcome.features). */
  features: Record<string, number | null | undefined>;
  /** The graded label: 0 = loss, >0 = doublings won (CandidateOutcome.labelValue). */
  labelValue: number;
  anchorPriceUsd: number;
  anchorMcapUsd: number;
}

export const CURATOR_MODEL_KIND = "weighted-logistic-v1";

/**
 * Everything needed to score a candidate, serialized into CuratorModel.params. Vectorization:
 * each feature contributes TWO inputs - its standardized value (0 when missing) and a
 * missing-indicator (1 when missing). Nulls carry signal here ("RugCheck hasn't indexed it" is
 * information), and indicators let the model learn that signal instead of having fake zeros
 * quietly poison the real ones. weights has length 2n: [values..., indicators...].
 */
export interface TrainedCuratorParams {
  kind: typeof CURATOR_MODEL_KIND;
  featureNames: string[];
  means: number[];
  stdevs: number[];
  weights: number[];
  bias: number;
  /** Emit when predicted probability >= this - calibrated by calibrateThreshold. */
  threshold: number;
}

const LEARNING_RATE = 0.5;
const ITERATIONS = 400;
const L2_LAMBDA = 0.01;

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Standardized values + missing indicators, as one flat vector of length 2n. */
function vectorize(
  features: Record<string, number | null | undefined>,
  featureNames: string[],
  means: number[],
  stdevs: number[],
): number[] {
  const n = featureNames.length;
  const x = new Array<number>(2 * n).fill(0);
  for (let j = 0; j < n; j++) {
    const raw = features[featureNames[j]!];
    if (raw === null || raw === undefined || !Number.isFinite(raw)) {
      x[n + j] = 1;
    } else {
      x[j] = (raw - means[j]!) / stdevs[j]!;
    }
  }
  return x;
}

/**
 * Folded rather than spread. Math.max(...array) passes every row as a separate argument and
 * overflows the call stack somewhere around a hundred thousand of them - which this set reaches
 * simply by succeeding, since it grows with every scanned candidate over a 60-day window.
 */
function maxAnchorMs(rows: TrainingRow[]): number {
  let max = -Infinity;
  for (const row of rows) {
    const t = row.anchorAt.getTime();
    if (t > max) max = t;
  }
  return max;
}

function minAnchorMs(rows: TrainingRow[]): number {
  let min = Infinity;
  for (const row of rows) {
    const t = row.anchorAt.getTime();
    if (t < min) min = t;
  }
  return min;
}

export interface TrainOptions {
  /**
   * Half-life for recency decay of sample weights, in days: a row this much older than the
   * NEWEST row in the set counts half as much. Referenced to the newest row, not to wall-clock
   * now, so training is a pure function of its rows - the same set always yields the same model,
   * whenever it's trained. Omitted = no decay (every row weighs its label-worth alone).
   */
  recencyHalfLifeDays?: number;
}

/**
 * Trains the model on labeled rows. Sample weights encode the "prefer higher multiples" choice:
 * a loss weighs 1, a winner weighs 1 + labelValue - so a clean 16x (label 4) pulls the boundary
 * five times as hard as any single loss, exactly its worth in doublings. On top of that,
 * recencyHalfLifeDays (when set) decays every weight by the row's age: this market's meta
 * rotates in weeks, and an equal-weighted long window spends a third of its gradient learning a
 * regime that no longer exists.
 */
export function trainCurator(
  rows: TrainingRow[],
  opts: TrainOptions = {},
): Omit<TrainedCuratorParams, "threshold"> {
  if (rows.length === 0) throw new Error("cannot train on zero rows");
  const featureNames = [...CANDIDATE_FEATURE_NAMES];
  const n = featureNames.length;

  // Standardization stats over PRESENT values only - missing values are represented by the
  // indicator half of the vector, never imputed into the mean.
  const means = new Array<number>(n).fill(0);
  const stdevs = new Array<number>(n).fill(1);
  for (let j = 0; j < n; j++) {
    const present = rows
      .map((r) => r.features[featureNames[j]!])
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    if (present.length === 0) continue;
    const mean = present.reduce((s, v) => s + v, 0) / present.length;
    const variance = present.reduce((s, v) => s + (v - mean) ** 2, 0) / present.length;
    means[j] = mean;
    stdevs[j] = variance > 0 ? Math.sqrt(variance) : 1;
  }

  const xs = rows.map((r) => vectorize(r.features, featureNames, means, stdevs));
  const ys = rows.map((r) => (r.labelValue > 0 ? 1 : 0));
  const sampleWeights = rows.map((r) => 1 + Math.max(0, r.labelValue));
  if (opts.recencyHalfLifeDays !== undefined && opts.recencyHalfLifeDays > 0) {
    const newestMs = maxAnchorMs(rows);
    const halfLifeMs = opts.recencyHalfLifeDays * 86_400_000;
    for (let i = 0; i < rows.length; i++) {
      sampleWeights[i] = sampleWeights[i]! * 0.5 ** ((newestMs - rows[i]!.anchorAt.getTime()) / halfLifeMs);
    }
  }
  const totalWeight = sampleWeights.reduce((s, w) => s + w, 0);

  const dim = 2 * n;
  const weights = new Array<number>(dim).fill(0);
  let bias = 0;

  // Full-batch gradient descent - at this scale each pass is microseconds, so no need for the
  // extra machinery (and nondeterminism) of stochastic methods.
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const grad = new Array<number>(dim).fill(0);
    let gradBias = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      let z = bias;
      for (let j = 0; j < dim; j++) z += weights[j]! * x[j]!;
      const err = (sigmoid(z) - ys[i]!) * sampleWeights[i]!;
      for (let j = 0; j < dim; j++) grad[j] = grad[j]! + err * x[j]!;
      gradBias += err;
    }
    // Simple decay keeps late iterations from oscillating; the bias is never regularized.
    const lr = LEARNING_RATE / (1 + iter / 100);
    for (let j = 0; j < dim; j++) {
      weights[j] = weights[j]! - lr * (grad[j]! / totalWeight + L2_LAMBDA * weights[j]!);
    }
    bias -= lr * (gradBias / totalWeight);
  }

  return { kind: CURATOR_MODEL_KIND, featureNames, means, stdevs, weights, bias };
}

/** Predicted probability of a clean 2x-within-15-minutes for one candidate's feature vector. */
export function scoreCandidateWithModel(
  params: Omit<TrainedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): number {
  const x = vectorize(features, params.featureNames, params.means, params.stdevs);
  let z = params.bias;
  for (let j = 0; j < x.length; j++) z += params.weights[j]! * x[j]!;
  return sigmoid(z);
}

/**
 * Picks the emission threshold: the probability that would have emitted at `targetPerHour` over
 * the calibration rows' own time span, floored at twice the base win rate so a dead market
 * emits nothing rather than the least-bad garbage. The rows are (roughly) hourly-spaced samples
 * per token, so "emissions among rows" approximates "newly eligible tokens" - the same thing the
 * production cooldown enforces.
 */
export function calibrateThreshold(
  params: Omit<TrainedCuratorParams, "threshold">,
  rows: TrainingRow[],
  targetPerHour: number,
): number {
  if (rows.length === 0) return 0.5;
  const probs = rows.map((r) => scoreCandidateWithModel(params, r.features)).sort((a, b) => b - a);
  const spanMs = maxAnchorMs(rows) - minAnchorMs(rows);
  const spanHours = Math.max(1, spanMs / 3_600_000);
  const allowed = Math.min(probs.length, Math.max(1, Math.round(targetPerHour * spanHours)));
  const byRate = probs[allowed - 1]!;

  // Twice the base rate, but never below an absolute floor: with a 0% base rate the relative
  // floor vanishes entirely, and an absurd target rate would then emit every row. The absolute
  // floor stays low in absolute terms - 2x-within-15-minutes is a rare event, so predicted
  // probabilities compress downward and a floor set for an hour-long bar would silence the feed
  // - but 0.08 rather than the 0.04 it briefly sat at: the feed is a curated promise, and a call
  // the model itself gives a one-in-twelve chance is not one. The RELATIVE floor is still the
  // main guard ("at least twice as likely as random"); this one catches a degenerate market.
  const baseRate = rows.filter((r) => r.labelValue > 0).length / rows.length;
  const floor = Math.max(0.08, Math.min(0.95, 2 * baseRate));
  return Math.max(byRate, floor);
}

/**
 * The signals that pushed THIS candidate over the model's line, strongest first - the model-side
 * equivalent of the heuristic's reasons, from the same inspectable weights that made the
 * decision. Contributions are per base feature (its value input plus its missing-indicator
 * input), positive ones only.
 */
export function topModelReasons(
  params: Omit<TrainedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
  limit = 4,
): string[] {
  const x = vectorize(features, params.featureNames, params.means, params.stdevs);
  const n = params.featureNames.length;
  const contributions = params.featureNames.map((name, j) => ({
    name,
    value: params.weights[j]! * x[j]! + params.weights[n + j]! * x[n + j]!,
  }));
  return contributions
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((c) => {
      const label = FRIENDLY_FEATURE_LABELS[c.name as keyof typeof FRIENDLY_FEATURE_LABELS] ?? c.name;
      return `model signal: ${label}`;
    });
}

export interface FoldSide {
  emitted: number;
  perHour: number;
  /** % of emissions that were clean wins; null when nothing was emitted. */
  precisionPct: number | null;
  /** Mean labelValue (doublings) per emission; null when nothing was emitted. */
  avgLabel: number | null;
}

export interface EvalFold {
  testFrom: string;
  testTo: string;
  trainRows: number;
  testRows: number;
  baseWinRatePct: number;
  /** Mean labelValue across ALL test rows - what blind, random emission would earn per alert. */
  meanLabelPerRow: number;
  model: FoldSide;
  heuristic: FoldSide;
}

export interface PromotionVerdict {
  promote: boolean;
  reason: string;
}

export interface WalkForwardResult {
  folds: EvalFold[];
  verdict: PromotionVerdict;
}

export interface WalkForwardOptions {
  /** How many sequential test folds to carve out of the newest part of the history. */
  folds?: number;
  /** A fold whose training slice is thinner than this is skipped as meaningless. */
  minTrainRows?: number;
  /** A fold whose test slice is thinner than this is skipped as noise. */
  minTestRows?: number;
  targetPerHour: number;
  /** The heuristic's score floor (env CURATED_MIN_SCORE), so both sides play the real gate. */
  heuristicMinScore: number;
  /**
   * The mcap band emission actually enforces (env MCAP_FILTER_MIN/MAX). Applied as a pre-filter
   * to BOTH sides' emissions here, because it is applied before either curator in production
   * (see maybeEmitCuratedAlert) - without it the backtest would grade the curators on
   * out-of-band emissions production never makes. Omitted = no band (tests).
   */
  mcapBand?: McapBand;
  /** Total-rows floor below which promotion is refused outright. */
  minRowsToPromote?: number;
  /** Recency decay applied to each fold's training slice - see TrainOptions. */
  recencyHalfLifeDays?: number;
  /** Emissions a side needs in a fold before its average means anything - see decidePromotion. */
  minEmissionsToWin?: number;
}

function sideMetrics(emittedRows: TrainingRow[], spanHours: number): FoldSide {
  const emitted = emittedRows.length;
  const wins = emittedRows.filter((r) => r.labelValue > 0).length;
  return {
    emitted,
    perHour: emitted / spanHours,
    precisionPct: emitted > 0 ? (wins / emitted) * 100 : null,
    avgLabel: emitted > 0 ? emittedRows.reduce((s, r) => s + r.labelValue, 0) / emitted : null,
  };
}

/**
 * Time-ordered evaluation: for each of the last `folds` slices of history, train on everything
 * strictly before the slice, then compare model vs heuristic on the slice itself. Never a random
 * split - these are time series, and a random split lets the model peek at the future's price
 * regime and grade itself on the past's.
 */
export function walkForwardEvaluate(rows: TrainingRow[], opts: WalkForwardOptions): WalkForwardResult {
  const foldCount = opts.folds ?? 3;
  const minTrainRows = opts.minTrainRows ?? 300;
  const minTestRows = opts.minTestRows ?? 50;
  const minRowsToPromote = opts.minRowsToPromote ?? 1_500;

  const sorted = [...rows].sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
  const folds: EvalFold[] = [];

  if (sorted.length >= minTrainRows + minTestRows) {
    // Test folds tile the newest 50% of history; the oldest 50% is the first fold's training
    // floor. Each later fold trains on strictly more history, mirroring how the training job
    // will actually behave as data accumulates.
    const testStartIndex = Math.floor(sorted.length * 0.5);
    const testRowsTotal = sorted.length - testStartIndex;
    const perFold = Math.floor(testRowsTotal / foldCount);

    for (let f = 0; f < foldCount; f++) {
      const start = testStartIndex + f * perFold;
      const end = f === foldCount - 1 ? sorted.length : start + perFold;
      const train = sorted.slice(0, start);
      const test = sorted.slice(start, end);
      if (train.length < minTrainRows || test.length < minTestRows) continue;

      const inBand = (r: TrainingRow) => !opts.mcapBand || inMcapBand(r.anchorMcapUsd, opts.mcapBand);

      const params = trainCurator(train, { recencyHalfLifeDays: opts.recencyHalfLifeDays });
      // Calibrated on the band-filtered train slice, exactly as the training job calibrates the
      // deployable threshold - a fold whose threshold is ranked against unemittable rows grades
      // a model production never ships. Training itself stays full-window (mcap is a feature).
      const trainEmittable = train.filter(inBand);
      const threshold = calibrateThreshold(
        params,
        trainEmittable.length > 0 ? trainEmittable : train,
        opts.targetPerHour,
      );

      const spanMs = test[test.length - 1]!.anchorAt.getTime() - test[0]!.anchorAt.getTime();
      const spanHours = Math.max(1, spanMs / 3_600_000);

      // Everything a fold judges - emissions AND the blind-chance baselines - is measured over
      // the rows either curator could actually emit. Out-of-band test rows skew high (they're
      // disproportionately past breakouts still sampled via the actively-viewed path), and
      // letting them into meanLabelPerRow would raise the "beat blind chance" bar with wins
      // nobody was allowed to pick.
      const testEmittable = test.filter(inBand);

      // Both sides play the GOVERNED policy production actually runs (curation/governor.ts):
      // clear your gate, then only the strongest targetPerHour x span picks make the feed,
      // strongest conviction first. Grading all-above-threshold instead would score a firehose
      // neither curator is allowed to be - and would flatter whichever side over-emits, since
      // extra mediocre picks pad `emitted` while the governor would have cut exactly those.
      const emissionBudget = Math.max(1, Math.round(opts.targetPerHour * spanHours));
      const takeBest = (ranked: { row: TrainingRow; confidence: number }[]): TrainingRow[] =>
        ranked
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, emissionBudget)
          .map((x) => x.row);

      const modelEmitted = takeBest(
        testEmittable
          .map((row) => ({ row, confidence: scoreCandidateWithModel(params, row.features) }))
          .filter(({ confidence }) => confidence >= threshold),
      );
      const heuristicEmitted = takeBest(
        testEmittable.flatMap((row) => {
          const scored = scoredFromFeatures(row.features, row.anchorPriceUsd, row.anchorMcapUsd);
          if (!evaluateCandidateHeuristic(scored, opts.heuristicMinScore).curate) return [];
          return [{ row, confidence: curationRankScore(scored) }];
        }),
      );

      folds.push({
        testFrom: test[0]!.anchorAt.toISOString(),
        testTo: test[test.length - 1]!.anchorAt.toISOString(),
        trainRows: train.length,
        testRows: test.length,
        baseWinRatePct:
          testEmittable.length > 0
            ? (testEmittable.filter((r) => r.labelValue > 0).length / testEmittable.length) * 100
            : 0,
        meanLabelPerRow:
          testEmittable.length > 0
            ? testEmittable.reduce((s, r) => s + r.labelValue, 0) / testEmittable.length
            : 0,
        model: sideMetrics(modelEmitted, spanHours),
        heuristic: sideMetrics(heuristicEmitted, spanHours),
      });
    }
  }

  return {
    folds,
    verdict: decidePromotion(folds, rows.length, minRowsToPromote, opts.minEmissionsToWin),
  };
}

/**
 * Emissions a side needs in a fold before its average label is evidence rather than luck. Below
 * this, one fluke 4x among three picks "beats" a steady fifty-pick record - and the newest-fold
 * requirement, the promotion rule's whole recency guard, could be satisfied by exactly that
 * noise. A side under the floor is treated as not having meaningfully emitted at all.
 */
const MIN_FOLD_EMISSIONS_TO_WIN = 5;

/**
 * The promotion rule, spelled out so the learning panel can show WHY:
 *  - refuse outright below the training-rows floor or with fewer than 2 scoreable folds;
 *  - a fold is scoreable when at least one side emitted;
 *  - the model wins a fold by a higher avgLabel (expected doublings per alert); when the
 *    heuristic emitted too few to judge (under minEmissionsToWin), the model instead has to beat
 *    BLIND CHANCE convincingly - an avgLabel over twice the fold's per-row mean label, i.e. its
 *    picks earn at least double what random emission would have - and it loses outright when its
 *    own emissions are under that same floor (an average over a handful of picks is luck, not a
 *    record);
 *  - promote when the model wins a strict majority of scoreable folds INCLUDING the newest one.
 *    The newest-fold requirement is the recency guard: a model that used to be good and just
 *    stopped being good must not take over on its record.
 */
export function decidePromotion(
  folds: EvalFold[],
  totalRows: number,
  minRowsToPromote: number,
  minEmissionsToWin: number = MIN_FOLD_EMISSIONS_TO_WIN,
): PromotionVerdict {
  if (totalRows < minRowsToPromote) {
    return {
      promote: false,
      reason: `insufficient data: ${totalRows} rows, need ${minRowsToPromote}`,
    };
  }

  const scoreable = folds.filter((f) => f.model.emitted > 0 || f.heuristic.emitted > 0);
  if (scoreable.length < 2) {
    return { promote: false, reason: `only ${scoreable.length} scoreable fold(s), need 2` };
  }

  const modelWon = (f: EvalFold): boolean => {
    if (f.model.emitted < minEmissionsToWin) return false;
    if (f.heuristic.emitted < minEmissionsToWin) return (f.model.avgLabel ?? 0) > 2 * f.meanLabelPerRow;
    return (f.model.avgLabel ?? 0) > (f.heuristic.avgLabel ?? 0);
  };

  const wins = scoreable.filter(modelWon).length;
  const wonNewest = modelWon(scoreable[scoreable.length - 1]!);
  const promote = wins * 2 > scoreable.length && wonNewest;
  return {
    promote,
    reason: `model won ${wins}/${scoreable.length} scoreable folds${wonNewest ? "" : ", but not the newest"}${
      promote ? " - promoting" : " - keeping current curator"
    }`,
  };
}
