import type { McapBand } from "./curator.js";
import {
  calibrateThresholdForPrecision,
  confidenceRanks,
  precisionCurve,
  probabilityAtRank,
  thresholdAtRank,
  trainCuratorModel,
  walkForwardEvaluate,
  type CuratorLearner,
  type PrecisionCalibration,
  type PrecisionCurvePoint,
  type PrecisionTargets,
  type PromotionVerdict,
  type ServedCuratorExtras,
  type TrainedCuratorParams,
  type TrainingRow,
  type UnthresholdedCuratorParams,
  type WalkForwardResult,
  type EvalFold,
  type ScoredOutcome,
  scoreCandidateWithModel,
} from "./trainer.js";
import { CANDIDATE_FEATURE_NAMES } from "./features.js";
import {
  CONSENSUS_CONTESTANT,
  RULES_CONTESTANT,
  type ContestantSpec,
  type CuratorRecipe,
} from "./contestants.js";
import { emptyRecord, recordScore, type CallRecord } from "./leaderboard.js";
import type { Challenger, Replacement } from "./evolution.js";
import { quantileTable, trainStackedCurator, type StackedCuratorParams } from "./stacking.js";
import { trainBlendCurator, type BlendCuratorParams } from "./blend.js";
import { buildCalibration } from "./calibration.js";
import { featureHealthReport, type FeatureReport } from "./featureReport.js";
import { featureOnset, type HeldFeature } from "./featureOnset.js";

/**
 * One training run, minus the IO: examine every enabled model family on the same walk-forward
 * exam, keep the one with the better out-of-sample hit-rate record, train it on the full window
 * and set its cutoff. The worker's curatorTrainingJob loads the rows and stores the result;
 * scripts/compareLearners.ts runs the very same function on synthetic data.
 */

/**
 * The threshold a model gets when its exam had no evidence to set a cutoff from (no cutoff with
 * minSupport calls): above any probability either family can produce, so it sends nothing. Such
 * a model is never promoted, so this only ever applies to a shadow candidate. A finite number on
 * purpose - params are stored as JSON, and Infinity would round-trip as null.
 */
export const NEVER_EMIT_THRESHOLD = 1.01;

export interface CuratorTrainingConfig {
  targets: PrecisionTargets;
  targetPerHour: number;
  heuristicMinScore: number;
  mcapBand?: McapBand;
  minRowsToPromote: number;
  recencyHalfLifeDays?: number;
  cooldownHours: number;
  heuristicPrecisionGate: boolean;
  /** Families to examine, in order of preference when their records tie. */
  learners: readonly CuratorLearner[];
  /** Weight multiplier for legacy-rule rows in training (env CURATOR_LEGACY_LABEL_WEIGHT). */
  legacyLabelWeight?: number;
  /** Fewest wins a judged exam fold must hold (env CURATOR_EXAM_MIN_FOLD_WINS). */
  minTestWins?: number;
  /**
   * The confidence rank above which a call is tiered "high conviction" (env
   * CURATED_HIGH_CONVICTION_RANK): 0.995 = the top half-percent of decision moments. Omitted =
   * no tiering.
   */
  highConvictionRank?: number;
  /** How far back the recent-calls calibration looks (env CURATOR_CALIBRATION_WINDOW_DAYS). Omitted = all of them. */
  calibrationWindowDays?: number;
  /**
   * Hold back inputs too new (or too lately dead) to train on - see curation/featureOnset.ts
   * (env CURATOR_FEATURE_ONSET_GUARD). Omitted = off.
   */
  featureOnsetGuard?: boolean;
}

/** How one family did in this run's exam - stored for every family, shipped or not. */
export interface FamilyResult {
  learner: CuratorLearner;
  verdict: PromotionVerdict;
  /** Its hit-rate cutoff in confidence-rank units, with the record behind it. */
  precisionCalibration: PrecisionCalibration;
}

/** What the training job stores as CuratorModel.evalMetrics: the exam plus the hit-rate evidence. */
export interface StoredEvalMetrics {
  folds: WalkForwardResult["folds"];
  verdict: WalkForwardResult["verdict"];
  targets: PrecisionTargets;
  /** The family that shipped. Absent on rows from before families existed (logistic). */
  learner?: CuratorLearner;
  /** Every family's exam result, the shipped one included. */
  familyComparison?: FamilyResult[];
  /**
   * The model's hit-rate cutoff in CONFIDENCE-RANK units (share of decision moments scored lower
   * - see WalkForwardResult.outOfSampleRanks), with the hit rate it earned out of sample. The
   * shipped model's probability cutoff translated from it is params.threshold.
   */
  precisionCalibration: PrecisionCalibration;
  /** The model's hit-rate curve, also in rank units. */
  precisionCurve: PrecisionCurvePoint[];
  /**
   * The heuristic's hit-rate cutoff, in rank-score units - see heuristicCutoff in curatedAlerts.ts.
   * Absent when the exam had too few heuristic calls to judge any cutoff.
   */
  heuristicCalibration?: PrecisionCalibration;
  heuristicPrecisionCurve: PrecisionCurvePoint[];
  /** The contestant this row belongs to (contest runs only). */
  contestant?: string;
  /** The name it trained under - an evolving seat's name changes with its recipe. */
  contestantName?: string;
  /** The exam's governed call record - what the leaderboard scores before live calls exist. */
  exam?: CallRecord;
  /** The high-conviction tier's rank cutoff and its out-of-sample record, when tiering is on. */
  highConviction?: { rank: number; record: CallRecord };
  /** How many recent out-of-sample calls the calibration table was fitted on (0 = no table). */
  calibrationCalls?: number;
  /** Per-feature null rates and decile lifts over the rows this run's exam graded. */
  featureReport?: FeatureReport;
  /** Inputs this run held back as too new (or lately dead) to train on - see featureOnset.ts. */
  heldFeatures?: HeldFeature[];
}

export interface CuratorTrainingOutcome {
  params: TrainedCuratorParams;
  metrics: StoredEvalMetrics;
  /** The chosen family's exam (for logging and offline scripts). */
  evaluation: WalkForwardResult;
}

/**
 * Picks the family to ship from the exam results, best first:
 *  1. one whose cutoff met the targets beats one whose cutoff is a best-effort miss;
 *  2. then one whose exam earned promotion (it beat the heuristic fold by fold);
 *  3. when both met the targets, the one whose cutoff sends more alerts - more of them is
 *     strictly more tradeable calls;
 *  4. then the higher 2x rate at the cutoff (when neither met the targets: the closer miss);
 *  5. then the earlier family in the configured order (logistic first: simpler, so it keeps the
 *     job on an exact tie).
 * Choosing between two families on the same evidence is itself a (small) best-of-two search;
 * the leave-one-fold-out grading inside the exam is what keeps that honest.
 */
export function pickCuratorFamily(results: FamilyResult[]): number {
  let best = 0;
  const key = (r: FamilyResult) => [
    r.precisionCalibration.meetsTargets === true ? 1 : 0,
    r.verdict.promote ? 1 : 0,
    r.precisionCalibration.meetsTargets === true ? r.precisionCalibration.support : 0,
    r.precisionCalibration.winRatePct ?? -1,
  ];
  for (let i = 1; i < results.length; i++) {
    const a = key(results[i]!);
    const b = key(results[best]!);
    for (let k = 0; k < a.length; k++) {
      if (a[k]! !== b[k]!) {
        if (a[k]! > b[k]!) best = i;
        break;
      }
    }
  }
  return best;
}

/** One model recipe's exam and its deployable model - the shared core of every training run. */
interface RecipeExam {
  evaluation: WalkForwardResult;
  result: FamilyResult;
  trained: UnthresholdedCuratorParams;
  /** The shipped model's probability cutoff, or null when the exam could not set one. */
  deployedThreshold: number | null;
  /** The high-conviction line and the calibration table - see ServedCuratorExtras. */
  extras: ServedCuratorExtras;
  /** The high-conviction tier's out-of-sample record, when tiering is on. */
  highConviction: StoredEvalMetrics["highConviction"];
  /** The shipped model's probabilities over the reference rows (aligned with it). */
  shippedProbabilities: Float64Array;
}

/** The out-of-sample record of every call at or above a rank cutoff, cooldown replayed. */
function recordAbove(calls: ScoredOutcome[], rankCutoff: number, cooldownMs: number): CallRecord {
  const record = emptyRecord();
  const above = calls.filter((c) => c.probability >= rankCutoff);
  const byTime = [...above].sort((a, b) => (a.anchorAt?.getTime() ?? 0) - (b.anchorAt?.getTime() ?? 0));
  const lastSent = new Map<string, number>();
  for (const c of byTime) {
    if (c.tokenId !== undefined && c.anchorAt !== undefined) {
      const t = c.anchorAt.getTime();
      const last = lastSent.get(c.tokenId);
      if (last !== undefined && t - last < cooldownMs) continue;
      lastSent.set(c.tokenId, t);
    }
    record.calls += 1;
    record.graded += 1;
    if (c.labelValue > 0) record.wins += 1;
    if (c.labelValue >= Math.log2(4)) record.goals += 1;
    record.sumLabel += c.labelValue;
  }
  return record;
}

/**
 * What ships beside a model's cutoff: the high-conviction line (the probability at
 * cfg.highConvictionRank over the reference rows, the same way the cutoff is translated) and the
 * calibration table fitted on the newest out-of-sample calls (curation/calibration.ts).
 */
function servedExtras(
  cfg: Pick<CuratorTrainingConfig, "highConvictionRank" | "calibrationWindowDays" | "cooldownHours">,
  outOfSampleRanks: ScoredOutcome[],
  shippedProbabilities: ArrayLike<number>,
  translate: (rank: number) => number | null,
): { extras: ServedCuratorExtras; highConviction: StoredEvalMetrics["highConviction"] } {
  const extras: ServedCuratorExtras = {};
  let highConviction: StoredEvalMetrics["highConviction"];
  if (cfg.highConvictionRank !== undefined && outOfSampleRanks.length > 0) {
    const threshold = translate(cfg.highConvictionRank);
    if (threshold !== null) extras.highConvictionThreshold = threshold;
    highConviction = {
      rank: cfg.highConvictionRank,
      record: recordAbove(outOfSampleRanks, cfg.highConvictionRank, cfg.cooldownHours * 3_600_000),
    };
  }
  const calibration = buildCalibration(
    outOfSampleRanks,
    quantileTable(shippedProbabilities),
    (cfg.calibrationWindowDays ?? Infinity) * 86_400_000,
  );
  if (calibration) extras.calibration = calibration;
  return { extras, highConviction };
}

/**
 * The inputs a run may train on: everything, or with the onset guard on, everything except
 * inputs too new (or lately dead) - see curation/featureOnset.ts.
 */
function runFeatures(
  rows: TrainingRow[],
  cfg: Pick<CuratorTrainingConfig, "featureOnsetGuard">,
): { usable: ReadonlySet<string> | null; held: HeldFeature[] } {
  if (!cfg.featureOnsetGuard) return { usable: null, held: [] };
  const { usable, held } = featureOnset(rows, CANDIDATE_FEATURE_NAMES);
  return { usable: new Set(usable), held };
}

/** A recipe narrowed to the run's usable inputs; one left with none keeps its own list. */
function narrowRecipe(recipe: CuratorRecipe, usable: ReadonlySet<string> | null): CuratorRecipe {
  if (usable === null) return recipe;
  const wanted = recipe.featureNames ?? CANDIDATE_FEATURE_NAMES;
  const kept = wanted.filter((f) => usable.has(f));
  if (kept.length === wanted.length || kept.length === 0) return recipe;
  return { ...recipe, featureNames: kept };
}

async function examineRecipe(
  rows: TrainingRow[],
  cfg: Omit<CuratorTrainingConfig, "learners">,
  wholeRecipe: CuratorRecipe,
  usable: ReadonlySet<string> | null = null,
): Promise<RecipeExam> {
  const recipe = narrowRecipe(wholeRecipe, usable);
  const cooldown = { cooldownMs: cfg.cooldownHours * 3_600_000 };
  const recencyHalfLifeDays = recipe.recencyHalfLifeDays ?? cfg.recencyHalfLifeDays;
  const evaluation = await walkForwardEvaluate(rows, {
    targetPerHour: cfg.targetPerHour,
    heuristicMinScore: cfg.heuristicMinScore,
    // Emission enforces the band before either curator runs (see maybeEmitCuratedAlert), so
    // the exam has to as well - otherwise it grades emissions production never makes.
    mcapBand: cfg.mcapBand,
    minRowsToPromote: cfg.minRowsToPromote,
    recencyHalfLifeDays,
    // Graded and calibrated on event rows only - the moments live curators actually decide on.
    decisionRowsOnly: true,
    cooldownHours: cfg.cooldownHours,
    // Both sides are graded at the hit-rate cutoffs production holds them to, not at a pace.
    targets: cfg.targets,
    heuristicPrecisionGate: cfg.heuristicPrecisionGate,
    learner: recipe.learner,
    featureNames: recipe.featureNames,
    boosting: recipe.boosting,
    twoStage: recipe.twoStage,
    legacyLabelWeight: cfg.legacyLabelWeight,
    minTestWins: cfg.minTestWins,
  });
  // Calibrated in RANK units: each fold model and the shipped model put probabilities on their
  // own scales, so a raw probability that hit 75% on the fold models says nothing about the
  // same number on the shipped one. "The top r of decision moments" does carry over.
  const precisionCalibration = calibrateThresholdForPrecision(
    evaluation.outOfSampleRanks,
    cfg.targets,
    cooldown,
  );
  // The deployable model trains on the FULL window - the folds were the exam, this is the model
  // that ships, with strictly more (and newer) data than any fold saw.
  const trained = await trainCuratorModel(rows, {
    recencyHalfLifeDays,
    learner: recipe.learner,
    featureNames: recipe.featureNames,
    boosting: recipe.boosting,
    twoStage: recipe.twoStage,
    legacyLabelWeight: cfg.legacyLabelWeight,
  });
  // The targets are what the feed aims for, not a gate: when no cutoff met them, the model ships
  // at its best-effort cutoff (see chooseCutoff) and still competes on its exam. Only an exam
  // with no judgeable cutoff at all leaves it without one.
  const deployedThreshold =
    precisionCalibration.threshold === null
      ? null
      : thresholdAtRank(trained, evaluation.decisionReference, precisionCalibration.threshold);
  const shippedProbabilities = Float64Array.from(evaluation.decisionReference, (r) =>
    scoreCandidateWithModel(trained, r.features),
  );
  const { extras, highConviction } = servedExtras(
    cfg,
    evaluation.outOfSampleRanks,
    shippedProbabilities,
    (rank) => thresholdAtRank(trained, evaluation.decisionReference, rank),
  );
  return {
    evaluation,
    result: { learner: recipe.learner, verdict: evaluation.verdict, precisionCalibration },
    trained,
    deployedThreshold,
    extras,
    highConviction,
    shippedProbabilities,
  };
}

/** A verdict that promotes needs a cutoff to promote at. */
function verdictWithCutoff(exam: RecipeExam): PromotionVerdict {
  const { verdict } = exam.evaluation;
  return verdict.promote && exam.deployedThreshold === null
    ? {
        promote: false,
        reason: `${verdict.reason.replace(" - promoting", "")}, but too few out-of-sample calls to set a cutoff - keeping current curator`,
      }
    : verdict;
}

/** One side of the walk-forward folds, summed into a call record. */
function foldsRecord(folds: EvalFold[], side: "model" | "heuristic"): CallRecord {
  const record = emptyRecord();
  for (const fold of folds) {
    const s = fold[side];
    record.calls += s.emitted;
    record.graded += s.emitted;
    record.wins += Math.round(((s.precisionPct ?? 0) * s.emitted) / 100);
    record.goals += Math.round(((s.goalPrecisionPct ?? 0) * s.emitted) / 100);
    record.sumLabel += (s.avgLabel ?? 0) * s.emitted;
  }
  return record;
}

export async function runCuratorTraining(
  rows: TrainingRow[],
  cfg: CuratorTrainingConfig,
): Promise<CuratorTrainingOutcome> {
  if (cfg.learners.length === 0) throw new Error("no curator model families enabled");
  const cooldown = { cooldownMs: cfg.cooldownHours * 3_600_000 };

  const features = runFeatures(rows, cfg);
  const exams: RecipeExam[] = [];
  for (const learner of cfg.learners)
    exams.push(await examineRecipe(rows, cfg, { learner }, features.usable));
  const chosen = exams[pickCuratorFamily(exams.map((e) => e.result))]!;
  const { evaluation, trained, deployedThreshold, extras } = chosen;
  const { learner, precisionCalibration } = chosen.result;

  // The hand-tuned heuristic gets its cutoff the same way while it holds the job. Its calls do not
  // depend on the model family, so any family's exam carries the same heuristic record.
  const heuristicCalibration = calibrateThresholdForPrecision(
    evaluation.heuristicOutOfSample,
    cfg.targets,
    cooldown,
  );
  const params = {
    ...trained,
    threshold: deployedThreshold ?? NEVER_EMIT_THRESHOLD,
    ...extras,
  } as TrainedCuratorParams;
  const verdict = verdictWithCutoff(chosen);
  const metrics: StoredEvalMetrics = {
    folds: evaluation.folds,
    verdict: exams.length > 1 ? { ...verdict, reason: `${learner}: ${verdict.reason}` } : verdict,
    targets: cfg.targets,
    learner,
    familyComparison: exams.map((e) => e.result),
    precisionCalibration,
    precisionCurve: precisionCurve(evaluation.outOfSampleRanks),
    ...(chosen.highConviction ? { highConviction: chosen.highConviction } : {}),
    calibrationCalls: extras.calibration?.calls ?? 0,
    ...(cfg.featureOnsetGuard ? { heldFeatures: features.held } : {}),
    // Stored only when there was evidence to set a cutoff from. Without it the heuristic keeps
    // sending on its gate alone (see heuristicGate in curatedAlerts.ts).
    ...(heuristicCalibration.threshold !== null ? { heuristicCalibration } : {}),
    heuristicPrecisionCurve: precisionCurve(evaluation.heuristicOutOfSample),
  };
  return { params, metrics, evaluation };
}

/** The rules contestant's stored "model": just the hit-rate cutoff its exam earned. */
export const RULES_MODEL_KIND = "rules-v1";

export interface RulesCuratorParams {
  kind: typeof RULES_MODEL_KIND;
  minScore: number;
  /** Rank-score cutoff, or null when the exam had no evidence for one (the gate stands alone). */
  rankCutoff: number | null;
}

export type ContestantParams =
  TrainedCuratorParams | StackedCuratorParams | BlendCuratorParams | RulesCuratorParams;

export interface ContestantTrainingResult {
  contestant: string;
  params: ContestantParams;
  metrics: StoredEvalMetrics;
}

export interface ContestTrainingConfig extends Omit<CuratorTrainingConfig, "learners"> {
  /** The enabled roster (enabledContestants). */
  contestants: readonly ContestantSpec[];
}

/** A learner's exam, packaged: its stored result plus the rank arrays the consensus stacks on. */
interface LearnerExam {
  result: ContestantTrainingResult;
  examScore: number | null;
  evaluation: WalkForwardResult;
  /** Out-of-sample fold probabilities and the shipped model's probabilities, per reference row. */
  foldRanks: Float64Array | null;
  shipped: Float64Array | null;
  /** 1 where the fold rank clears the exam's own rank cutoff (what the exam called), per reference row. */
  calls: Uint8Array | null;
}

async function examineLearner(
  rows: TrainingRow[],
  cfg: ContestTrainingConfig,
  slot: string,
  name: string,
  recipe: CuratorRecipe,
  reference: TrainingRow[] | null,
  usable: ReadonlySet<string> | null,
): Promise<LearnerExam> {
  const exam = await examineRecipe(rows, cfg, recipe, usable);
  const { evaluation, trained, deployedThreshold } = exam;
  const verdict = verdictWithCutoff(exam);
  const record = foldsRecord(evaluation.folds, "model");
  const result: ContestantTrainingResult = {
    contestant: slot,
    params: {
      ...trained,
      threshold: deployedThreshold ?? NEVER_EMIT_THRESHOLD,
      ...exam.extras,
    } as TrainedCuratorParams,
    metrics: {
      contestant: slot,
      contestantName: name,
      folds: evaluation.folds,
      verdict: { ...verdict, reason: `${name}: ${verdict.reason}` },
      targets: cfg.targets,
      learner: recipe.learner,
      precisionCalibration: exam.result.precisionCalibration,
      precisionCurve: precisionCurve(evaluation.outOfSampleRanks),
      heuristicPrecisionCurve: [],
      exam: record,
      ...(exam.highConviction ? { highConviction: exam.highConviction } : {}),
      calibrationCalls: exam.extras.calibration?.calls ?? 0,
    },
  };
  // Every learner's exam cuts the same rows into the same folds, so their reference rows (and
  // so their rank arrays) line up one to one; checked rather than assumed.
  const ref = reference ?? evaluation.decisionReference;
  const aligned =
    ref.length > 0 &&
    evaluation.decisionReference.length === ref.length &&
    evaluation.decisionReference.every((r, i) => r === ref[i]);
  const rankCutoff = exam.result.precisionCalibration.threshold;
  return {
    result,
    examScore: recordScore(record, cfg.targets),
    evaluation,
    foldRanks: aligned ? Float64Array.from(evaluation.outOfSampleRanks, (c) => c.probability) : null,
    shipped: aligned ? exam.shippedProbabilities : null,
    calls:
      aligned && rankCutoff !== null
        ? Uint8Array.from(evaluation.outOfSampleRanks, (c) => (c.probability >= rankCutoff ? 1 : 0))
        : null,
  };
}

/**
 * The exam evidence behind a takeover decision: every side's calls over the SAME reference rows,
 * so a challenger and a lane can be compared pairwise (see pairedBootstrapConfidence).
 */
export interface ExamEvidence {
  /** The reference rows' labels, in reference order. */
  labels: Float64Array;
  /** Per lane slot: 1 where its exam called the row. Absent when its exam set no cutoff. */
  laneCalls: Map<string, Uint8Array>;
  /** Per challenger, in breeding order; null when its exam set no cutoff. */
  challengerCalls: (Uint8Array | null)[];
  /** Wins in each challenger's exam record, in breeding order. */
  challengerExamWins: number[];
}

/**
 * How a run evolves the field (curation/evolution.ts): the challengers bred for it, and the rule
 * that picks a takeover once every exam is in.
 */
export interface EvolutionPlan {
  challengers: readonly Challenger[];
  decide: (
    laneExamScores: Map<string, number | null>,
    challengerScores: (number | null)[],
    evidence: ExamEvidence,
  ) => Replacement | null;
}

export interface ContestRunOutcome {
  /** One per contestant, in roster order - the takeover already applied to its seat. */
  results: ContestantTrainingResult[];
  challengerScores: (number | null)[];
  /** The takeover this run made, if any. */
  replacement: (Replacement & { bred: Challenger; examScore: number | null }) | null;
}

/**
 * One contest training run, minus the IO: every learner contestant sits the same walk-forward
 * exam and ships its own model at its own hit-rate cutoff; the rules contestant gets its cutoff
 * from the same exam; then the consensus is stacked on the learners' out-of-sample calls. Results
 * come back in roster order, one per enabled contestant that had anything to train.
 *
 * With an evolution plan, the run's challengers sit the same exam after the lanes; a takeover
 * swaps the winning challenger into its seat BEFORE the consensus is stacked, so the consensus
 * always learns the lineup that will actually call.
 *
 * Learners train one after another and only their rank arrays (plus the best challenger so far)
 * are kept between them, so peak memory is about two models' working sets however many
 * contestants and challengers run; time grows linearly.
 */
export async function runEvolvingContest(
  rows: TrainingRow[],
  cfg: ContestTrainingConfig,
  plan?: EvolutionPlan,
): Promise<ContestRunOutcome> {
  const cooldown = { cooldownMs: cfg.cooldownHours * 3_600_000 };
  const results: ContestantTrainingResult[] = [];
  const foldRanks = new Map<string, Float64Array>();
  const shippedProbabilities = new Map<string, Float64Array>();
  const laneExamScores = new Map<string, number | null>();
  let reference: TrainingRow[] | null = null;
  let rulesEvidence: { folds: EvalFold[]; heuristicOutOfSample: ScoredOutcome[] } | null = null;

  const laneCalls = new Map<string, Uint8Array>();
  const keep = (slot: string, exam: LearnerExam) => {
    if (exam.foldRanks && exam.shipped) {
      foldRanks.set(slot, exam.foldRanks);
      shippedProbabilities.set(slot, exam.shipped);
    } else {
      foldRanks.delete(slot);
      shippedProbabilities.delete(slot);
    }
    if (exam.calls) laneCalls.set(slot, exam.calls);
    else laneCalls.delete(slot);
  };
  // Measured once, on the rows every learner's exam grades: the inputs' health this run.
  let featureReport: FeatureReport | null = null;
  // Decided once for the whole field: the inputs too new (or lately dead) to train on.
  const features = runFeatures(rows, cfg);
  const heldFeatures = cfg.featureOnsetGuard ? { heldFeatures: features.held } : {};

  for (const spec of cfg.contestants) {
    if (spec.role !== "learner" || !spec.recipe) continue;
    const exam = await examineLearner(rows, cfg, spec.id, spec.name, spec.recipe, reference, features.usable);
    if (reference === null) {
      reference = exam.evaluation.decisionReference;
      rulesEvidence = {
        folds: exam.evaluation.folds,
        heuristicOutOfSample: exam.evaluation.heuristicOutOfSample,
      };
      featureReport = featureHealthReport(reference);
    }
    if (featureReport) exam.result.metrics.featureReport = featureReport;
    Object.assign(exam.result.metrics, heldFeatures);
    results.push(exam.result);
    laneExamScores.set(spec.id, exam.examScore);
    keep(spec.id, exam);
  }

  const challengerScores: (number | null)[] = [];
  const challengerCalls: (Uint8Array | null)[] = [];
  const challengerExamWins: number[] = [];
  let bestChallenger: { index: number; exam: LearnerExam } | null = null;
  for (const [i, bred] of (plan?.challengers ?? []).entries()) {
    const exam = await examineLearner(rows, cfg, "", bred.name, bred.recipe, reference, features.usable);
    challengerScores.push(exam.examScore);
    challengerCalls.push(exam.calls);
    challengerExamWins.push(exam.result.metrics.exam?.wins ?? 0);
    if (
      exam.examScore !== null &&
      (bestChallenger === null || exam.examScore > bestChallenger.exam.examScore!)
    ) {
      bestChallenger = { index: i, exam };
    }
  }
  let replacement: ContestRunOutcome["replacement"] = null;
  const decided =
    plan && challengerScores.length > 0
      ? plan.decide(laneExamScores, challengerScores, {
          labels: Float64Array.from(reference ?? [], (r) => r.labelValue),
          laneCalls,
          challengerCalls,
          challengerExamWins,
        })
      : null;
  if (decided && bestChallenger && decided.challenger === bestChallenger.index) {
    const { exam } = bestChallenger;
    const slot = decided.slot;
    const seat = results.findIndex((r) => r.contestant === slot);
    if (seat !== -1) {
      results[seat] = {
        contestant: slot,
        params: exam.result.params,
        metrics: {
          ...exam.result.metrics,
          contestant: slot,
          ...(featureReport ? { featureReport } : {}),
          ...heldFeatures,
        },
      };
      keep(slot, exam);
      replacement = { ...decided, bred: plan!.challengers[decided.challenger]!, examScore: exam.examScore };
    }
  }

  const rulesSpec = cfg.contestants.find((c) => c.role === "rules");
  if (rulesSpec && rulesEvidence) {
    const calibration = calibrateThresholdForPrecision(
      rulesEvidence.heuristicOutOfSample,
      cfg.targets,
      cooldown,
    );
    const curve = precisionCurve(rulesEvidence.heuristicOutOfSample);
    results.push({
      contestant: rulesSpec.id,
      params: {
        kind: RULES_MODEL_KIND,
        minScore: cfg.heuristicMinScore,
        rankCutoff: cfg.heuristicPrecisionGate ? calibration.threshold : null,
      },
      metrics: {
        contestant: rulesSpec.id,
        contestantName: rulesSpec.name,
        folds: rulesEvidence.folds,
        verdict: { promote: false, reason: `${rulesSpec.name}: the hand-tuned gate, held to its own cutoff` },
        targets: cfg.targets,
        precisionCalibration: calibration,
        precisionCurve: curve,
        ...(calibration.threshold !== null ? { heuristicCalibration: calibration } : {}),
        heuristicPrecisionCurve: curve,
        exam: foldsRecord(rulesEvidence.folds, "heuristic"),
      },
    });
  }

  const stackedSpec = cfg.contestants.find((c) => c.role === "stacked");
  if (stackedSpec && reference !== null && foldRanks.size >= 2) {
    const stacked = await trainStackedCurator(
      {
        reference,
        memberFoldRanks: foldRanks,
        memberShippedProbabilities: shippedProbabilities,
        heuristicMinScore: cfg.heuristicMinScore,
        targets: cfg.targets,
        cooldownHours: cfg.cooldownHours,
        targetPerHour: cfg.targetPerHour,
        recencyHalfLifeDays: cfg.recencyHalfLifeDays,
      },
      NEVER_EMIT_THRESHOLD,
    );
    if (stacked) {
      const served = servedExtras(cfg, stacked.outOfSample, stacked.shippedProbabilities, (rank) =>
        probabilityAtRank(stacked.shippedProbabilities, rank),
      );
      results.push({
        contestant: stackedSpec.id,
        params: { ...stacked.params, ...served.extras },
        metrics: {
          ...(served.highConviction ? { highConviction: served.highConviction } : {}),
          calibrationCalls: served.extras.calibration?.calls ?? 0,
          contestant: stackedSpec.id,
          contestantName: stackedSpec.name,
          folds: [],
          verdict: {
            promote: false,
            reason: `${stackedSpec.name}: stacked on ${stacked.params.members.length} models, judged on ${stacked.examChunks} later chunk(s) of their out-of-sample calls`,
          },
          targets: cfg.targets,
          precisionCalibration: stacked.precisionCalibration,
          precisionCurve: stacked.precisionCurve,
          heuristicPrecisionCurve: [],
          exam: stacked.exam,
        },
      });
    }
  }

  const blendSpec = cfg.contestants.find((c) => c.role === "blend");
  if (blendSpec && reference !== null && foldRanks.size >= 2) {
    const blend = trainBlendCurator(
      {
        reference,
        memberFoldRanks: foldRanks,
        memberShippedProbabilities: shippedProbabilities,
        targets: cfg.targets,
        cooldownHours: cfg.cooldownHours,
        targetPerHour: cfg.targetPerHour,
      },
      NEVER_EMIT_THRESHOLD,
    );
    if (blend) {
      // Blend scores are mean member ranks, on one scale for folds and serving - but not
      // uniform: they bunch around the middle. The tier line and the calibration both work in
      // percentile units, so the scores become their own percentiles first, and a percentile
      // line translates back to the blend score at that percentile.
      const blendScores = blend.outOfSample.map((c) => c.probability);
      const blendPercentiles = confidenceRanks(blendScores);
      const served = servedExtras(
        cfg,
        blend.outOfSample.map((c, i) => ({ ...c, probability: blendPercentiles[i]! })),
        blendScores,
        (rank) => probabilityAtRank(blendScores, rank),
      );
      results.push({
        contestant: blendSpec.id,
        params: { ...blend.params, ...served.extras },
        metrics: {
          contestant: blendSpec.id,
          contestantName: blendSpec.name,
          folds: [],
          verdict: {
            promote: false,
            reason: `${blendSpec.name}: ${blend.params.members.length} models' ranks averaged, judged on ${blend.examChunks} chunk(s) of their out-of-sample calls`,
          },
          targets: cfg.targets,
          precisionCalibration: blend.precisionCalibration,
          precisionCurve: blend.precisionCurve,
          heuristicPrecisionCurve: [],
          exam: blend.exam,
          ...(served.highConviction ? { highConviction: served.highConviction } : {}),
          calibrationCalls: served.extras.calibration?.calls ?? 0,
        },
      });
    }
  }

  // Roster order, so storage and logs read the same way the leaderboard lists them.
  const order = new Map(cfg.contestants.map((c, i) => [c.id, i]));
  results.sort((a, b) => order.get(a.contestant)! - order.get(b.contestant)!);
  return { results, challengerScores, replacement };
}

/** A contest run with a fixed field - no challengers (offline scripts, tests). */
export async function runContestTraining(
  rows: TrainingRow[],
  cfg: ContestTrainingConfig,
): Promise<ContestantTrainingResult[]> {
  return (await runEvolvingContest(rows, cfg)).results;
}

/**
 * The feed a subscriber sees until they pick a model: the consensus once its latest run gave it
 * a cutoff to call at, else Rules (no consensus yet, or an exam with nothing to set a cutoff
 * from - a default feed that can never send would be no feed at all). The worker and the API
 * both decide with this, so "default" means the same model on both sides.
 */
export function defaultContestant(consensusThreshold: number | null | undefined): string {
  return typeof consensusThreshold === "number" && consensusThreshold < NEVER_EMIT_THRESHOLD
    ? CONSENSUS_CONTESTANT
    : RULES_CONTESTANT;
}
