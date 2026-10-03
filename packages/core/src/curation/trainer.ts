import { CANDIDATE_FEATURE_NAMES, FRIENDLY_FEATURE_LABELS, scoredFromFeatures } from "./features.js";
import { curationRankScore, evaluateCandidateHeuristic, inMcapBand, type McapBand } from "./curator.js";
import { CANDIDATE_WATCH_WINDOW_MINUTES, GOAL_MULTIPLE } from "./labels.js";

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
  /**
   * How the row was sampled (CandidateOutcome.sampleKind). Only "event" rows are moments a live
   * curator actually decides on - see WalkForwardOptions.decisionRowsOnly. Omitted = treated as a
   * decision moment (tests, and callers with no sampling distinction).
   */
  sampleKind?: string;
  /**
   * Which token the row samples. Optional so pure tests can omit it; when present the
   * walk-forward exam keeps a token out of the training slice of any fold it is tested in, and
   * replays the per-token alert cooldown production enforces.
   */
  tokenId?: string;
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
  /**
   * How raw feature values are reshaped before standardization - see transformFeature. Absent
   * on models trained before transforms existed, which keep scoring on raw values exactly as
   * they were trained.
   */
  transform?: FeatureTransform;
}

/**
 * "signed-log1p-v1": heavy-tailed features (dollar amounts, counts, ratios, % moves) go through
 * sign(x) * log(1 + |x|) before standardization. A linear model on raw values lets one $5M
 * volume print or a +4000% candle dominate every coefficient it touches; on a log scale a 10x
 * difference is one step whatever the magnitude.
 */
export type FeatureTransform = "signed-log1p-v1";
export const CURRENT_FEATURE_TRANSFORM: FeatureTransform = "signed-log1p-v1";

/**
 * Features left on their raw scale under the log transform: already bounded (0-100 scores and
 * shares, 0/1 flags) or small counts where a log adds nothing.
 */
const UNTRANSFORMED_FEATURES = new Set([
  "buyRatio24h",
  "buyRatio1h",
  "top10HolderPct",
  "devWalletPct",
  "riskScore",
  "freshTop10WalletPct",
  "emptyTop10WalletPct",
  "graduated",
  "hasTwitter",
  "hasTelegram",
  "hasWebsite",
  "hasDescription",
  "dexBoosted",
  "narrativeTagCount",
  "scoreMomentum",
  "scoreHolderHealth",
  "scoreAge",
  "scoreNarrative",
  "scoreTotal",
]);

/** Applies a model's feature transform to one raw value. */
export function transformFeature(name: string, raw: number, transform: FeatureTransform | undefined): number {
  if (transform === undefined || UNTRANSFORMED_FEATURES.has(name)) return raw;
  return Math.sign(raw) * Math.log1p(Math.abs(raw));
}

const LEARNING_RATE = 0.5;
const ITERATIONS = 400;

/**
 * How many gradient iterations run before handing the event loop back.
 *
 * Small enough that no single stretch of CPU outlasts a scan tick, large enough that the yields
 * themselves are noise against the work between them.
 */
const YIELD_EVERY_ITERATIONS = 25;

/** Lets pending timers and I/O run - see the note in the gradient loop. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
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
  transform: FeatureTransform | undefined,
): number[] {
  const n = featureNames.length;
  const x = new Array<number>(2 * n).fill(0);
  for (let j = 0; j < n; j++) {
    const raw = features[featureNames[j]!];
    if (raw === null || raw === undefined || !Number.isFinite(raw)) {
      x[n + j] = 1;
    } else {
      x[j] = (transformFeature(featureNames[j]!, raw, transform) - means[j]!) / stdevs[j]!;
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
 * Trains the model on labeled rows. Every row weighs the same: the output is used as a
 * probability (the cutoff is set by hit rate), and weighting winners by how far they ran - as
 * this once did, 1 + labelValue - inflates every predicted probability toward the big runs.
 * recencyHalfLifeDays (when set) decays each weight by the row's age: this market's meta
 * rotates in weeks, and an equal-weighted long window spends a third of its gradient learning a
 * regime that no longer exists.
 *
 * Features go through CURRENT_FEATURE_TRANSFORM before standardization, and the model records
 * which transform it was trained with so scoring applies the same one.
 */
export async function trainCurator(
  rows: TrainingRow[],
  opts: TrainOptions = {},
): Promise<Omit<TrainedCuratorParams, "threshold">> {
  if (rows.length === 0) throw new Error("cannot train on zero rows");
  const featureNames = [...CANDIDATE_FEATURE_NAMES];
  const n = featureNames.length;
  const transform = CURRENT_FEATURE_TRANSFORM;

  // Standardization stats over PRESENT values only - missing values are represented by the
  // indicator half of the vector, never imputed into the mean.
  const means = new Array<number>(n).fill(0);
  const stdevs = new Array<number>(n).fill(1);
  for (let j = 0; j < n; j++) {
    const present = rows
      .map((r) => r.features[featureNames[j]!])
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
      .map((v) => transformFeature(featureNames[j]!, v, transform));
    if (present.length === 0) continue;
    const mean = present.reduce((s, v) => s + v, 0) / present.length;
    const variance = present.reduce((s, v) => s + (v - mean) ** 2, 0) / present.length;
    means[j] = mean;
    stdevs[j] = variance > 0 ? Math.sqrt(variance) : 1;
  }

  const xs = rows.map((r) => vectorize(r.features, featureNames, means, stdevs, transform));
  const ys = rows.map((r) => (r.labelValue > 0 ? 1 : 0));
  const sampleWeights = rows.map(() => 1);
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

  // Full-batch gradient descent, yielding to the event loop periodically.
  //
  // A pass is O(rows x 2 x features), and at the row counts this window is sized for - 60 days
  // of hourly samples across hundreds of tokens - 400 of them is seconds of solid CPU, times the
  // four models a training run fits (three walk-forward folds plus the deployable one). Run
  // straight through, that blocks the worker's whole event loop: the minutely scan does not
  // scan, and the candidate watcher misses ticks inside the very windows whose
  // resolution the labels and the public grades depend on. Training would degrade the data it
  // trains on. Yielding costs a fraction of the runtime and keeps both on cadence.
  for (let iter = 0; iter < ITERATIONS; iter++) {
    if (iter > 0 && iter % YIELD_EVERY_ITERATIONS === 0) await yieldToEventLoop();
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

  return { kind: CURATOR_MODEL_KIND, featureNames, means, stdevs, weights, bias, transform };
}

/** Predicted probability of a clean 2x-within-1-hour for one candidate's feature vector. */
export function scoreCandidateWithModel(
  params: Omit<TrainedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): number {
  const x = vectorize(features, params.featureNames, params.means, params.stdevs, params.transform);
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
  // floor stays low in absolute terms - a clean 2x is a rare event, so predicted probabilities
  // compress downward - but 0.08 rather than the 0.04 it briefly sat at: the feed is a curated promise, and a call
  // the model itself gives a one-in-twelve chance is not one. The RELATIVE floor is still the
  // main guard ("at least twice as likely as random"); this one catches a degenerate market.
  const baseRate = rows.filter((r) => r.labelValue > 0).length / rows.length;
  const floor = Math.max(0.08, Math.min(0.95, 2 * baseRate));
  return Math.max(byRate, floor);
}

/** One out-of-sample call: what a model trained strictly before this row predicted for it. */
export interface ScoredOutcome {
  probability: number;
  labelValue: number;
  /**
   * The row's token and moment. When both are present on every call and a cooldown is given,
   * calibration replays production's per-token alert cooldown (see calibrateThresholdForPrecision).
   */
  tokenId?: string;
  anchorAt?: Date;
}

/**
 * The hit-rate targets the feed is held to: of the alerts sent, the share that doubled (win) and
 * the share that reached GOAL_MULTIPLE (goal) within the win window - both as fractions (0.75 =
 * 75%). minSupport is how many alerts a cutoff must have produced in the evidence before its hit
 * rate counts as a measurement rather than a lucky streak.
 */
export interface PrecisionTargets {
  winRate: number;
  goalRate: number;
  minSupport: number;
}

/** labelValue is log2 of the peak multiple for clean wins, so the goal is labelValue >= log2(4). */
const GOAL_LABEL = Math.log2(GOAL_MULTIPLE);

export interface PrecisionCalibration {
  /** The lowest probability whose calls met BOTH targets, or null when no cutoff did. */
  threshold: number | null;
  /** Alerts the chosen cutoff (or, when unreachable, the best-scoring one) produced. */
  support: number;
  winRatePct: number | null;
  goalRatePct: number | null;
}

/**
 * Picks the emission threshold by HIT RATE rather than pace: walking down the calls from most to
 * least confident, the lowest cutoff at which the calls above it still met both targets on at
 * least minSupport alerts. "Lowest" because every alert that still meets the bar is one more
 * tradeable call. Null when no cutoff meets the bar - the honest answer is then to send nothing
 * rather than to send whatever is least bad.
 *
 * Fed OUT-OF-SAMPLE predictions (walk-forward test rows scored by a model that never saw them):
 * an in-sample hit rate is what a model believes about data it memorized, and it reliably
 * overstates the rate the feed will actually achieve.
 */
export function calibrateThresholdForPrecision(
  calls: ScoredOutcome[],
  targets: PrecisionTargets,
  opts: { cooldownMs?: number } = {},
): PrecisionCalibration {
  if (
    opts.cooldownMs !== undefined &&
    calls.length > 0 &&
    calls.every((c) => c.tokenId !== undefined && c.anchorAt !== undefined)
  ) {
    return calibrateWithCooldown(calls, targets, opts.cooldownMs);
  }
  const sorted = [...calls].sort((a, b) => b.probability - a.probability);
  let wins = 0;
  let goals = 0;
  let chosen: PrecisionCalibration | null = null;
  let best: PrecisionCalibration = { threshold: null, support: 0, winRatePct: null, goalRatePct: null };
  for (let i = 0; i < sorted.length; i++) {
    const call = sorted[i]!;
    if (call.labelValue > 0) wins += 1;
    if (call.labelValue >= GOAL_LABEL) goals += 1;
    // Only judge at a boundary between distinct probabilities - a cutoff can't split a tie.
    const next = sorted[i + 1];
    if (next !== undefined && next.probability === call.probability) continue;
    const n = i + 1;
    if (n < targets.minSupport) continue;
    const winRate = wins / n;
    const goalRate = goals / n;
    const point = { support: n, winRatePct: winRate * 100, goalRatePct: goalRate * 100 };
    if (winRate >= targets.winRate && goalRate >= targets.goalRate) {
      chosen = { threshold: call.probability, ...point };
    } else if (chosen === null && (best.winRatePct === null || winRate * 100 > best.winRatePct)) {
      best = { threshold: null, ...point };
    }
  }
  return chosen ?? best;
}

/** How many candidate cutoffs the cooldown-aware calibration evaluates at most. */
const COOLDOWN_CALIBRATION_GRID = 400;

/**
 * The cutoff search, replaying the per-token alert cooldown. In production a token is alerted
 * the FIRST time it clears the cutoff and then not again for the cooldown, so the calls a cutoff
 * really sends are not "every row above it" - hourly samples of one hot token would otherwise
 * count many times and make a cutoff look better supported (and usually more accurate) than the
 * feed it produces. For each candidate cutoff the calls are walked in time order and a token's
 * call only counts when it is the first above the cutoff since that token's last counted call
 * plus the cooldown.
 *
 * That makes each cutoff a full pass, so cutoffs are taken from a grid over the distinct
 * probabilities (at most COOLDOWN_CALIBRATION_GRID of them) rather than all of them.
 */
function calibrateWithCooldown(
  calls: ScoredOutcome[],
  targets: PrecisionTargets,
  cooldownMs: number,
): PrecisionCalibration {
  const byTime = [...calls].sort((a, b) => a.anchorAt!.getTime() - b.anchorAt!.getTime());
  const distinct = [...new Set(calls.map((c) => c.probability))].sort((a, b) => b - a);
  const step = Math.max(1, Math.floor(distinct.length / COOLDOWN_CALIBRATION_GRID));
  const cutoffs: number[] = [];
  for (let i = step - 1; i < distinct.length; i += step) cutoffs.push(distinct[i]!);
  if (cutoffs[cutoffs.length - 1] !== distinct[distinct.length - 1])
    cutoffs.push(distinct[distinct.length - 1]!);

  let chosen: PrecisionCalibration | null = null;
  let best: PrecisionCalibration = { threshold: null, support: 0, winRatePct: null, goalRatePct: null };
  for (const cutoff of cutoffs) {
    const lastSent = new Map<string, number>();
    let n = 0;
    let wins = 0;
    let goals = 0;
    for (const call of byTime) {
      if (call.probability < cutoff) continue;
      const t = call.anchorAt!.getTime();
      const last = lastSent.get(call.tokenId!);
      if (last !== undefined && t - last < cooldownMs) continue;
      lastSent.set(call.tokenId!, t);
      n += 1;
      if (call.labelValue > 0) wins += 1;
      if (call.labelValue >= GOAL_LABEL) goals += 1;
    }
    if (n < targets.minSupport) continue;
    const winRate = wins / n;
    const goalRate = goals / n;
    const point = { support: n, winRatePct: winRate * 100, goalRatePct: goalRate * 100 };
    if (winRate >= targets.winRate && goalRate >= targets.goalRate) {
      chosen = { threshold: cutoff, ...point };
    } else if (chosen === null && (best.winRatePct === null || winRate * 100 > best.winRatePct)) {
      best = { threshold: null, ...point };
    }
  }
  return chosen ?? best;
}

/** One point on the hit-rate curve: what sending everything at or above `minProbability` earned. */
export interface PrecisionCurvePoint {
  minProbability: number;
  alerts: number;
  winRatePct: number;
  goalRatePct: number;
}

/**
 * The trade-off the targets sit on, as a short table: for the top 1%, 2%, 5%, 10%, 20% and 50% of
 * calls by confidence, how often they doubled and how often they reached the goal. Stored with
 * every trained model so "how close is the feed to 75%, and at what volume" can be read off the
 * record instead of re-derived.
 */
export function precisionCurve(calls: ScoredOutcome[]): PrecisionCurvePoint[] {
  const sorted = [...calls].sort((a, b) => b.probability - a.probability);
  const points: PrecisionCurvePoint[] = [];
  for (const fraction of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5]) {
    const n = Math.round(sorted.length * fraction);
    if (n < 1) continue;
    const top = sorted.slice(0, n);
    points.push({
      minProbability: top[n - 1]!.probability,
      alerts: n,
      winRatePct: (top.filter((c) => c.labelValue > 0).length / n) * 100,
      goalRatePct: (top.filter((c) => c.labelValue >= GOAL_LABEL).length / n) * 100,
    });
  }
  return points;
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
  const x = vectorize(features, params.featureNames, params.means, params.stdevs, params.transform);
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
  /** % of emissions that reached the 4x goal; null when nothing was emitted. */
  goalPrecisionPct: number | null;
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
  /**
   * Every emittable test row across the folds, scored by the fold model that never saw it - the
   * evidence calibrateThresholdForPrecision picks the deployable cutoff from. Not stored with the
   * model (it is one entry per row); summarize it first.
   */
  outOfSample: ScoredOutcome[];
  /**
   * The same evidence for the heuristic: every emittable test row that cleared its gate, with its
   * rank score as the "probability" - what the heuristic's own hit-rate cutoff is set from.
   */
  heuristicOutOfSample: ScoredOutcome[];
  /**
   * outOfSample again, with each call's probability replaced by its CONFIDENCE RANK inside its
   * own fold (see confidenceRanks): the share of that fold's emittable test rows its fold model
   * scored strictly lower. Each fold model has its own probability scale, and the model that
   * ships (trained on the full window) has yet another, so a raw probability cutoff learned from
   * the folds means something different on the shipped model. A rank cutoff - "the top 3% of
   * decision moments" - carries over: calibrate on this, then translate the rank to the shipped
   * model's probability with thresholdAtRank over decisionReference.
   */
  outOfSampleRanks: ScoredOutcome[];
  /**
   * The rows the ranks were measured against: every emittable test row of every judged fold
   * (the newest half of the history). thresholdAtRank scores these with the shipped model.
   */
  decisionReference: TrainingRow[];
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
  /**
   * Judge and calibrate on "event" rows only (rows whose sampleKind is set and isn't "event" are
   * still trained on, but never graded or used to set a cutoff). Production's curators decide only
   * at event moments, so a hit rate measured on hourly background samples describes a population
   * the feed never picks from.
   */
  decisionRowsOnly?: boolean;
  /**
   * Production's per-token alert cooldown (env CURATED_ALERT_COOLDOWN_HOURS). When set, each
   * side's emissions in a fold replay it - a token is picked the first time it clears the gate
   * and not again inside the cooldown - so one hot token sampled hourly can't fill a fold's
   * record the way it never could fill the real feed. Rows without a tokenId are never
   * deduplicated. Omitted = no cooldown (tests).
   */
  cooldownHours?: number;
  /**
   * The feed's hit-rate targets. When set, each side is graded at the cutoff production
   * actually applies to it - the model at its hit-rate rank cutoff, the heuristic at its
   * hit-rate rank-score cutoff (see heuristicPrecisionGate) - each calibrated on the OTHER
   * folds' out-of-sample calls, so no fold is graded with a cutoff chosen from its own outcomes.
   * Omitted = the older policy: the model at the pace cutoff (calibrateThreshold), the heuristic
   * on its gate alone.
   */
  targets?: PrecisionTargets;
  /**
   * Mirrors CURATED_HEURISTIC_PRECISION_GATE: whether the heuristic is held to its hit-rate
   * cutoff (only meaningful with targets). Default true.
   */
  heuristicPrecisionGate?: boolean;
}

/** Whether a row is a moment a live curator decides on - see WalkForwardOptions.decisionRowsOnly. */
export function isDecisionRow(row: TrainingRow): boolean {
  return row.sampleKind === undefined || row.sampleKind === "event";
}

function sideMetrics(emittedRows: TrainingRow[], spanHours: number): FoldSide {
  const emitted = emittedRows.length;
  const wins = emittedRows.filter((r) => r.labelValue > 0).length;
  const goals = emittedRows.filter((r) => r.labelValue >= GOAL_LABEL).length;
  return {
    emitted,
    perHour: emitted / spanHours,
    precisionPct: emitted > 0 ? (wins / emitted) * 100 : null,
    goalPrecisionPct: emitted > 0 ? (goals / emitted) * 100 : null,
    avgLabel: emitted > 0 ? emittedRows.reduce((s, r) => s + r.labelValue, 0) / emitted : null,
  };
}

/**
 * Time-ordered evaluation: for each of the last `folds` slices of history, train on everything
 * strictly before the slice, then compare model vs heuristic on the slice itself. Never a random
 * split - these are time series, and a random split lets the model peek at the future's price
 * regime and grade itself on the past's.
 */
export async function walkForwardEvaluate(
  rows: TrainingRow[],
  opts: WalkForwardOptions,
): Promise<WalkForwardResult> {
  const foldCount = opts.folds ?? 3;
  const minTrainRows = opts.minTrainRows ?? 300;
  const minTestRows = opts.minTestRows ?? 50;
  const minRowsToPromote = opts.minRowsToPromote ?? 1_500;

  const sorted = [...rows].sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
  const cooldownMs = opts.cooldownHours !== undefined ? opts.cooldownHours * 3_600_000 : undefined;
  const labelWindowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
  const inBand = (r: TrainingRow) =>
    (!opts.mcapBand || inMcapBand(r.anchorMcapUsd, opts.mcapBand)) &&
    (!opts.decisionRowsOnly || isDecisionRow(r));

  // Pass one: train each fold's model and score its test slice. Pass two (below) grades the
  // folds - it runs after all of them are scored because, with targets, a fold's cutoffs are
  // calibrated on the other folds' out-of-sample calls.
  interface ScoredFold {
    test: TrainingRow[];
    trainRows: number;
    testEmittable: TrainingRow[];
    spanHours: number;
    /** The pace cutoff, used only without targets. */
    paceThreshold: number;
    model: { row: TrainingRow; confidence: number; rank: number }[];
    heuristic: { row: TrainingRow; confidence: number }[];
  }
  const scoredFolds: ScoredFold[] = [];

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
      const test = sorted.slice(start, end);
      if (test.length === 0) continue;
      // Two leaks closed before training. A row's label is only known once its watch window
      // closes, so a training row anchored within that window of the fold's start was graded
      // on prices from inside the fold - it is purged. And a token tested in this fold never
      // trains it: hourly samples of one token are near-duplicates, and letting the model see
      // a token's earlier hours grades its memory of that token rather than its judgment.
      const testStartMs = test[0]!.anchorAt.getTime();
      const testTokens = new Set(test.flatMap((r) => (r.tokenId === undefined ? [] : [r.tokenId])));
      const train = sorted
        .slice(0, start)
        .filter(
          (r) =>
            r.anchorAt.getTime() + labelWindowMs <= testStartMs &&
            (r.tokenId === undefined || !testTokens.has(r.tokenId)),
        );
      if (train.length < minTrainRows || test.length < minTestRows) continue;

      const params = await trainCurator(train, { recencyHalfLifeDays: opts.recencyHalfLifeDays });
      // Without targets the model plays the pace cutoff, calibrated on the band-filtered train
      // slice - a threshold ranked against unemittable rows grades a model production never
      // ships. Training itself stays full-window (mcap is a feature).
      const trainEmittable = opts.targets ? [] : train.filter(inBand);
      const paceThreshold = opts.targets
        ? 0
        : calibrateThreshold(params, trainEmittable.length > 0 ? trainEmittable : train, opts.targetPerHour);

      const spanMs = test[test.length - 1]!.anchorAt.getTime() - test[0]!.anchorAt.getTime();

      // Everything a fold judges - emissions AND the blind-chance baselines - is measured over
      // the rows either curator could actually emit. Out-of-band test rows skew high (they're
      // disproportionately past breakouts still sampled via the actively-viewed path), and
      // letting them into meanLabelPerRow would raise the "beat blind chance" bar with wins
      // nobody was allowed to pick.
      const testEmittable = test.filter(inBand);
      const probabilities = testEmittable.map((row) => scoreCandidateWithModel(params, row.features));
      const ranks = confidenceRanks(probabilities);
      scoredFolds.push({
        test,
        trainRows: train.length,
        testEmittable,
        spanHours: Math.max(1, spanMs / 3_600_000),
        paceThreshold,
        model: testEmittable.map((row, i) => ({ row, confidence: probabilities[i]!, rank: ranks[i]! })),
        heuristic: testEmittable.flatMap((row) => {
          const scored = scoredFromFeatures(row.features, row.anchorPriceUsd, row.anchorMcapUsd);
          if (!evaluateCandidateHeuristic(scored, opts.heuristicMinScore).curate) return [];
          return [{ row, confidence: curationRankScore(scored) }];
        }),
      });
    }
  }

  const call = (row: TrainingRow, probability: number): ScoredOutcome => ({
    probability,
    labelValue: row.labelValue,
    tokenId: row.tokenId,
    anchorAt: row.anchorAt,
  });
  const outOfSample = scoredFolds.flatMap((f) => f.model.map((m) => call(m.row, m.confidence)));
  const outOfSampleRanks = scoredFolds.flatMap((f) => f.model.map((m) => call(m.row, m.rank)));
  // The heuristic's own out-of-sample record, in its own conviction units (rank score) - what its
  // hit-rate cutoff is calibrated from, exactly as the model's is from outOfSampleRanks.
  const heuristicOutOfSample = scoredFolds.flatMap((f) => f.heuristic.map((h) => call(h.row, h.confidence)));

  const folds: EvalFold[] = scoredFolds.map((fold, f) => {
    // Both sides play the GOVERNED policy production actually runs (curation/governor.ts):
    // clear your cutoff, then only the strongest targetPerHour x span picks make the feed,
    // strongest conviction first. Grading all-above-cutoff instead would score a firehose
    // neither curator is allowed to be - and would flatter whichever side over-emits, since
    // extra mediocre picks pad `emitted` while the governor would have cut exactly those.
    const emissionBudget = Math.max(1, Math.round(opts.targetPerHour * fold.spanHours));
    const takeBest = (ranked: { row: TrainingRow; confidence: number }[]): TrainingRow[] =>
      applyCooldown(ranked, cooldownMs)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, emissionBudget)
        .map((x) => x.row);

    let modelCalls: { row: TrainingRow; confidence: number }[];
    let heuristicCalls: { row: TrainingRow; confidence: number }[];
    if (opts.targets) {
      // Production's cutoffs, calibrated the way the training job calibrates them - but on the
      // other folds' calls only, so this fold is graded on outcomes its cutoff never saw.
      const others = scoredFolds.filter((_, g) => g !== f);
      const calibrate = (calls: ScoredOutcome[]) =>
        calibrateThresholdForPrecision(calls, opts.targets!, { cooldownMs });
      const modelCutoff = calibrate(others.flatMap((o) => o.model.map((m) => call(m.row, m.rank)))).threshold;
      modelCalls = modelCutoff === null ? [] : fold.model.filter((m) => m.rank >= modelCutoff);
      const heuristicCalibration = calibrate(
        others.flatMap((o) => o.heuristic.map((h) => call(h.row, h.confidence))),
      );
      // Same rule as production (heuristicGate in curatedAlerts.ts): no evidence at all leaves
      // the gate alone; evidence with no qualifying cutoff silences the heuristic.
      const gated = (opts.heuristicPrecisionGate ?? true) && heuristicCalibration.support > 0;
      const heuristicCutoff = heuristicCalibration.threshold;
      heuristicCalls = !gated
        ? fold.heuristic
        : heuristicCutoff === null
          ? []
          : fold.heuristic.filter((h) => h.confidence >= heuristicCutoff);
    } else {
      modelCalls = fold.model.filter((m) => m.confidence >= fold.paceThreshold);
      heuristicCalls = fold.heuristic;
    }

    const { test, testEmittable } = fold;
    return {
      testFrom: test[0]!.anchorAt.toISOString(),
      testTo: test[test.length - 1]!.anchorAt.toISOString(),
      trainRows: fold.trainRows,
      testRows: test.length,
      baseWinRatePct:
        testEmittable.length > 0
          ? (testEmittable.filter((r) => r.labelValue > 0).length / testEmittable.length) * 100
          : 0,
      meanLabelPerRow:
        testEmittable.length > 0
          ? testEmittable.reduce((s, r) => s + r.labelValue, 0) / testEmittable.length
          : 0,
      model: sideMetrics(takeBest(modelCalls), fold.spanHours),
      heuristic: sideMetrics(takeBest(heuristicCalls), fold.spanHours),
    };
  });

  return {
    folds,
    verdict: decidePromotion(folds, rows.length, minRowsToPromote, opts.minEmissionsToWin),
    outOfSample,
    heuristicOutOfSample,
    outOfSampleRanks,
    decisionReference: scoredFolds.flatMap((f) => f.testEmittable),
  };
}

/**
 * Each probability's confidence rank within its own set: the share of the set scored strictly
 * lower, in [0, 1). Ties share a rank, so a cutoff can never split them.
 */
export function confidenceRanks(probabilities: number[]): number[] {
  const n = probabilities.length;
  if (n === 0) return [];
  const ascending = [...probabilities].sort((a, b) => a - b);
  return probabilities.map((p) => lowerBound(ascending, p) / n);
}

/** Index of the first element >= value in an ascending array. */
function lowerBound(ascending: number[], value: number): number {
  let lo = 0;
  let hi = ascending.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ascending[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Translates a rank cutoff (from calibrating outOfSampleRanks) into a probability cutoff for the
 * model that actually ships: score the reference rows with it and take the lowest probability
 * whose rank there clears the cutoff. The shipped model then passes the same share of decision
 * moments that met the hit-rate targets in the exam, ranked by its own (better-informed) scale.
 * A cutoff above every reference rank falls back to the reference's best score. With no
 * reference rows there is nothing to translate against - null, and the model sends nothing.
 */
export function thresholdAtRank(
  params: Omit<TrainedCuratorParams, "threshold">,
  referenceRows: TrainingRow[],
  rankCutoff: number,
): number | null {
  if (referenceRows.length === 0) return null;
  const probabilities = referenceRows.map((r) => scoreCandidateWithModel(params, r.features));
  const ranks = confidenceRanks(probabilities);
  let cutoff: number | null = null;
  let best = -Infinity;
  for (let i = 0; i < probabilities.length; i++) {
    if (probabilities[i]! > best) best = probabilities[i]!;
    if (ranks[i]! >= rankCutoff && (cutoff === null || probabilities[i]! < cutoff))
      cutoff = probabilities[i]!;
  }
  return cutoff ?? best;
}

/**
 * Replays the per-token alert cooldown over a fold's gate-passing calls: in time order, a token's
 * call survives only when it is that token's first since its last surviving call plus the
 * cooldown. No cooldown, or a row with no tokenId, passes through untouched.
 */
function applyCooldown<T extends { row: TrainingRow }>(calls: T[], cooldownMs: number | undefined): T[] {
  if (cooldownMs === undefined) return [...calls];
  const byTime = [...calls].sort((a, b) => a.row.anchorAt.getTime() - b.row.anchorAt.getTime());
  const lastSent = new Map<string, number>();
  const kept: T[] = [];
  for (const call of byTime) {
    const tokenId = call.row.tokenId;
    if (tokenId === undefined) {
      kept.push(call);
      continue;
    }
    const t = call.row.anchorAt.getTime();
    const last = lastSent.get(tokenId);
    if (last !== undefined && t - last < cooldownMs) continue;
    lastSent.set(tokenId, t);
    kept.push(call);
  }
  return kept;
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
 *  - the model wins a fold by a higher HIT RATE (share of its alerts that doubled - the number
 *    the feed is held to), with avgLabel (expected doublings per alert) breaking an exact tie;
 *    when the heuristic emitted too few to judge (under minEmissionsToWin), the model instead
 *    has to beat BLIND CHANCE convincingly - a hit rate over twice the fold's base win rate -
 *    and it loses outright when its own emissions are under that same floor (a rate over a
 *    handful of picks is luck, not a record);
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
    const modelRate = f.model.precisionPct ?? 0;
    if (f.heuristic.emitted < minEmissionsToWin) return modelRate > 2 * f.baseWinRatePct;
    const heuristicRate = f.heuristic.precisionPct ?? 0;
    if (modelRate !== heuristicRate) return modelRate > heuristicRate;
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
