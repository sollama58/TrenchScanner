import type { McapBand } from "./curator.js";
import {
  calibrateThresholdForPrecision,
  confidenceRanks,
  precisionCurve,
  probabilityAtRank,
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
  type ExamPopulation,
  type EvalFold,
  type TrainingWeightByAge,
  trainingWeightByAge,
  type ScoredOutcome,
  scoreCandidateWithModel,
} from "./trainer.js";
import { CANDIDATE_FEATURE_NAMES, LEARNER_FEATURE_NAMES, withCurrentNarrativeTiming } from "./features.js";
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
import { trainAgreementCurator, type AgreementCuratorParams, type AgreementCurvePoint } from "./agreement.js";
import { trainTopSliceCurator, type TopSliceCuratorParams } from "./topSlice.js";
import { buildCalibration } from "./calibration.js";
import { runDoublings } from "./labels.js";
import {
  featureHealthReport,
  runnerTraitsReport,
  type FeatureReport,
  type RunnerReport,
} from "./featureReport.js";
import { featureOnset, type HeldFeature } from "./featureOnset.js";
import {
  describeRuleSet,
  distillRuleSet,
  examineRuleScores,
  scoreRuleSet,
  teacherAgreementPct,
  type DerivedRuleSet,
} from "./rulesDistill.js";
import { HAND_TUNED_RULE_LINES } from "./curator.js";

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
  /** Extra training weight per doubling a winner ran past 2x (env CURATOR_RUN_WEIGHT_PER_DOUBLING). */
  runWeightPerDoubling?: number;
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
  /** The Rules seat only: which rules it runs and why (see RulesInUse). */
  rulesInUse?: RulesInUse;
  /** The name it trained under - an evolving seat's name changes with its recipe. */
  contestantName?: string;
  /** The exam's governed call record - what the leaderboard scores before live calls exist. */
  exam?: CallRecord;
  /**
   * The high-conviction tier's rank cutoff and its out-of-sample record, when tiering is on.
   * `earned` (absent on older rows = earned) says whether that record out-scored the model's
   * cutoff record, which is what it takes for the shipped model to tier any call "high" (user
   * decision 2026-10-06): the tier claims more than the cutoff, so it has to show more.
   */
  highConviction?: { rank: number; record: CallRecord; earned?: boolean; cutoffRecord?: CallRecord };
  /** How many recent out-of-sample calls the calibration table was fitted on (0 = no table). */
  calibrationCalls?: number;
  /** Per-feature null rates and decile lifts over the rows this run's exam graded. */
  featureReport?: FeatureReport;
  /** What the winners that ran furthest had in common - see runnerTraitsReport. */
  runnerReport?: RunnerReport;
  /** Inputs this run held back as too new (or lately dead) to train on - see featureOnset.ts. */
  heldFeatures?: HeldFeature[];
  /** Which decision moments the exam graded (event rows alone, or with pseudo-events) - see ExamPopulation. */
  examPopulation?: ExamPopulation;
  /** The Agreement seat only: out-of-sample win rate by how many learners called (curation/agreement.ts). */
  agreementCurve?: AgreementCurvePoint[];
  /**
   * Learner seats: how far this seat's fit leaned toward the present - the share of its training
   * weight (under its own recency half-life) carried by the newest 1, 3 and 7 days of rows,
   * against the share of rows (trainingWeightByAge in trainer.ts). Absent on older rows.
   */
  trainingWeightByAge?: TrainingWeightByAge;
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
  const record: CallRecord = { ...emptyRecord(), tenX: 0, tenXGraded: 0 };
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
    if (c.hit10x === true) record.tenX! += 1;
    if (c.labelValue <= 0 || c.hit10x !== undefined) record.tenXGraded! += 1;
    record.sumLabel += c.labelValue;
    record.sumRun = (record.sumRun ?? 0) + runDoublings(c);
  }
  return record;
}

/**
 * What ships beside a model's cutoff: the high-conviction line (the probability at
 * cfg.highConvictionRank over the reference rows, the same way the cutoff is translated) and the
 * calibration table fitted on the newest out-of-sample calls (curation/calibration.ts).
 *
 * The line ships only when the tier EARNED it: its out-of-sample record (the calls at or above
 * the high-conviction rank) out-scores the cutoff record (the calls at or above `cutoff`, in the
 * same units as outOfSampleRanks). In production the top half-percent by rank doubled at 10.6%
 * against 18.5% for standard calls over 2026-10-03..06 - the very top of a model's range is
 * where extreme inputs live, not its best calls - so a tier that hasn't shown it beats the cutoff
 * is not shown at all (user decision 2026-10-06). Both records are still stored.
 */
function servedExtras(
  cfg: Pick<
    CuratorTrainingConfig,
    "highConvictionRank" | "calibrationWindowDays" | "cooldownHours" | "targets"
  >,
  outOfSampleRanks: ScoredOutcome[],
  shippedProbabilities: ArrayLike<number>,
  translate: (rank: number) => number | null,
  cutoff: number | null,
): { extras: ServedCuratorExtras; highConviction: StoredEvalMetrics["highConviction"] } {
  const extras: ServedCuratorExtras = {};
  let highConviction: StoredEvalMetrics["highConviction"];
  if (cfg.highConvictionRank !== undefined && outOfSampleRanks.length > 0) {
    const cooldownMs = cfg.cooldownHours * 3_600_000;
    const record = recordAbove(outOfSampleRanks, cfg.highConvictionRank, cooldownMs);
    const cutoffRecord = cutoff === null ? undefined : recordAbove(outOfSampleRanks, cutoff, cooldownMs);
    const earned =
      cutoffRecord !== undefined &&
      record.graded > 0 &&
      (recordScore(record, cfg.targets) ?? 0) > (recordScore(cutoffRecord, cfg.targets) ?? 0);
    const threshold = earned ? translate(cfg.highConvictionRank) : null;
    if (threshold !== null) extras.highConvictionThreshold = threshold;
    highConviction = {
      rank: cfg.highConvictionRank,
      record,
      earned,
      ...(cutoffRecord ? { cutoffRecord } : {}),
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
  const wanted = recipe.featureNames ?? LEARNER_FEATURE_NAMES;
  const kept = wanted.filter((f) => usable.has(f));
  if (kept.length === wanted.length || kept.length === 0) return recipe;
  return { ...recipe, featureNames: kept };
}

/**
 * The shipped model's probabilities over the reference rows, each scored by a model that never
 * trained on that row's token. The shipped model trains on the whole window, reference rows
 * included, so its own scores there are in-sample: a tree model has memorized those rows, and a
 * rank cutoff translated on them lands on a different share of new tokens than the exam
 * graded (2026-10-06: tree seats called 1.4-3.2x their exam's volume live, and read 2-5 points
 * lower). Cross-fitted instead: the reference tokens split in two, the recipe trains twice on
 * everything but one half's tokens and scores that half - the same scale as the shipped model
 * (same recipe, ~98% the same rows), seen the way it sees a live token. Two extra fits per
 * recipe; a half that can't be fitted (too few rows) keeps the in-sample scores.
 */
async function crossFittedProbabilities(
  rows: TrainingRow[],
  reference: TrainingRow[],
  shipped: UnthresholdedCuratorParams,
  train: (rows: TrainingRow[]) => Promise<UnthresholdedCuratorParams>,
): Promise<Float64Array> {
  const out = Float64Array.from(reference, (r) => scoreCandidateWithModel(shipped, r.features));
  if (reference.length < 2) return out;
  // Tokens alternate between halves in order of first appearance; a row with no token is its own.
  const half = new Map<string, number>();
  const rowHalf = reference.map((r, i) => {
    if (r.tokenId === undefined) return i % 2;
    let h = half.get(r.tokenId);
    if (h === undefined) {
      h = half.size % 2;
      half.set(r.tokenId, h);
    }
    return h;
  });
  for (const h of [0, 1]) {
    const held = new Set<TrainingRow>();
    for (let i = 0; i < reference.length; i++) if (rowHalf[i] === h) held.add(reference[i]!);
    if (held.size === 0) continue;
    const trainRows = rows.filter(
      (r) => !held.has(r) && (r.tokenId === undefined || half.get(r.tokenId) !== h),
    );
    if (trainRows.length < MIN_CROSS_FIT_ROWS) continue;
    const model = await train(trainRows);
    for (let i = 0; i < reference.length; i++) {
      if (rowHalf[i] === h) out[i] = scoreCandidateWithModel(model, reference[i]!.features);
    }
  }
  return out;
}

/** Fewer training rows than this and a cross-fit half keeps the shipped model's own scores. */
const MIN_CROSS_FIT_ROWS = 300;

/**
 * A recipe's walk-forward exam, before anything ships: the folds, the out-of-sample record and
 * its rank cutoff. Everything a challenger is judged on lives here (see shipRecipe).
 */
interface RecipeTrial {
  /** The recipe as examined - narrowed to the run's usable inputs. */
  recipe: CuratorRecipe;
  recencyHalfLifeDays: number | undefined;
  evaluation: WalkForwardResult;
  precisionCalibration: PrecisionCalibration;
}

async function sitRecipeExam(
  rows: TrainingRow[],
  cfg: Omit<CuratorTrainingConfig, "learners">,
  wholeRecipe: CuratorRecipe,
  usable: ReadonlySet<string> | null,
): Promise<RecipeTrial> {
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
    forest: recipe.forest,
    twoStage: recipe.twoStage,
    narrativeBlend: recipe.narrativeBlend,
    legacyLabelWeight: cfg.legacyLabelWeight,
    runWeightPerDoubling: cfg.runWeightPerDoubling,
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
  return { recipe, recencyHalfLifeDays, evaluation, precisionCalibration };
}

/**
 * The model a trial ships: the full-window fit, its cross-fitted scale and what serves beside
 * it. Three fits, none of which the exam score reads - so a challenger only pays for them once
 * it has won (runEvolvingContest). Every fit seeds its own RNG, so shipping later, or not at
 * all, changes nothing else the run trains.
 */
async function shipRecipe(
  rows: TrainingRow[],
  cfg: Omit<CuratorTrainingConfig, "learners">,
  trial: RecipeTrial,
): Promise<RecipeExam> {
  const { recipe, recencyHalfLifeDays, evaluation, precisionCalibration } = trial;
  // The deployable model trains on the FULL window - the folds were the exam, this is the model
  // that ships, with strictly more (and newer) data than any fold saw.
  const trainOpts = {
    recencyHalfLifeDays,
    learner: recipe.learner,
    featureNames: recipe.featureNames,
    boosting: recipe.boosting,
    forest: recipe.forest,
    twoStage: recipe.twoStage,
    narrativeBlend: recipe.narrativeBlend,
    legacyLabelWeight: cfg.legacyLabelWeight,
    runWeightPerDoubling: cfg.runWeightPerDoubling,
  };
  const trained = await trainCuratorModel(rows, trainOpts);
  // The shipped model's scale on tokens it has never seen: the cutoff, the high-conviction line,
  // the calibration table and the combiners' quantile tables all read these same probabilities.
  const shippedProbabilities = await crossFittedProbabilities(
    rows,
    evaluation.decisionReference,
    trained,
    (train) => trainCuratorModel(train, trainOpts),
  );
  const translate = (rank: number) => probabilityAtRank(shippedProbabilities, rank);
  // The targets are what the feed aims for, not a gate: when no cutoff met them, the model ships
  // at its best-effort cutoff (see chooseCutoff) and still competes on its exam. Only an exam
  // with no judgeable cutoff at all leaves it without one.
  const deployedThreshold =
    precisionCalibration.threshold === null ? null : translate(precisionCalibration.threshold);
  const { extras, highConviction } = servedExtras(
    cfg,
    evaluation.outOfSampleRanks,
    shippedProbabilities,
    translate,
    precisionCalibration.threshold,
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

async function examineRecipe(
  rows: TrainingRow[],
  cfg: Omit<CuratorTrainingConfig, "learners">,
  wholeRecipe: CuratorRecipe,
  usable: ReadonlySet<string> | null = null,
): Promise<RecipeExam> {
  return shipRecipe(rows, cfg, await sitRecipeExam(rows, cfg, wholeRecipe, usable));
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
  let sumRun: number | null = 0;
  let tenX: number | null = 0;
  let tenXGraded: number | null = 0;
  for (const fold of folds) {
    const s = fold[side];
    record.calls += s.emitted;
    record.graded += s.emitted;
    record.wins += Math.round(((s.precisionPct ?? 0) * s.emitted) / 100);
    record.goals += Math.round(((s.goalPrecisionPct ?? 0) * s.emitted) / 100);
    record.sumLabel += (s.avgLabel ?? 0) * s.emitted;
    // Run size on the live record's scale, when every fold recorded it; else the record carries
    // none and runSum() falls back to the label-window doublings (older stored exams).
    if (s.sumRun !== undefined && sumRun !== null) sumRun += s.sumRun;
    else sumRun = null;
    // The same for the 10x tier: folds stored before it was counted leave the record without it.
    if (s.tenX !== undefined && tenX !== null) tenX += s.tenX;
    else tenX = null;
    if (s.tenXGraded !== undefined && tenXGraded !== null) tenXGraded += s.tenXGraded;
    else tenXGraded = null;
  }
  if (sumRun !== null) record.sumRun = sumRun;
  if (tenX !== null && folds.length > 0) {
    record.tenX = tenX;
    if (tenXGraded !== null) record.tenXGraded = tenXGraded;
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
    examPopulation: evaluation.population,
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
  /**
   * The cutoff the seat sends at: in rank-score units for the hand-tuned gates (null when the
   * exam had no evidence for one - the gate stands alone), in table points for learned rules.
   */
  rankCutoff: number | null;
  /**
   * The points table learned from the best model (curation/rulesDistill.ts), when one won the
   * seat; absent = the hand-tuned gates.
   */
  derived?: DerivedRuleSet;
}

/**
 * What the Rules seat is running and why - stored on its evalMetrics for the Models tab and the
 * run log.
 */
export interface RulesInUse {
  source: "hand-tuned" | "learned";
  /** The checks in plain words, one per line. */
  lines: string[];
  /** Learned rules: the model they came from, when, and how closely they copy it. */
  teacher?: { contestant: string; name: string };
  derivedAt?: string;
  agreementPct?: number | null;
  /** True when this run changed the rules the seat runs. */
  changed: boolean;
  /** Every option this run weighed, with its exam score (null = no graded calls). */
  options: { label: string; examScore: number | null }[];
  reason: string;
}

export type ContestantParams =
  | TrainedCuratorParams
  | StackedCuratorParams
  | BlendCuratorParams
  | AgreementCuratorParams
  | TopSliceCuratorParams
  | RulesCuratorParams;

export interface ContestantTrainingResult {
  contestant: string;
  params: ContestantParams;
  metrics: StoredEvalMetrics;
}

export interface ContestTrainingConfig extends Omit<CuratorTrainingConfig, "learners"> {
  /** The enabled roster (enabledContestants). */
  contestants: readonly ContestantSpec[];
  /**
   * Learn the Rules seat's checks from the best model (env CURATOR_RULES_FROM_BEST). Off = the
   * hand-tuned gates, as before.
   */
  rulesFromBest?: boolean;
  /**
   * The learner seats to learn the rules from, best first (the default model, then the
   * leaderboard order). The first one this run examined is used; with none, the learner with the
   * best exam this run.
   */
  rulesTeachers?: readonly string[];
  /** The learned rules the seat runs now, if any - re-examined so it keeps them only on merit. */
  currentRules?: DerivedRuleSet | null;
  /**
   * The Narrative seat's second looks (contestants.ts): the rows the scan took when TokenSage's
   * deep read landed after a token's last decision, relabeled "event" - decision moments for this
   * seat alone. The seat's training set is these plus every row of the run (see
   * narrativeTrainingSet), built here rather than passed in, so the run's rows cross into the
   * training thread once. With fewer than NARRATIVE_MIN_ROWS deep-read rows in that set, the seat
   * is not examined this run and keeps its running model.
   */
  narrativeRows?: TrainingRow[];
}

/** Fewest deep-read rows the Narrative seat's exam runs on: under this its cutoff would be a coin flip. */
export const NARRATIVE_MIN_ROWS = 300;

/**
 * The sample kind a Narrative-seat training row without the deep read carries: it trains the
 * seat but is never one of its decision rows (isDecisionRow knows only "event" and "hourly"), so
 * the seat is graded and calibrated only on the moments it can decide on.
 */
export const NARRATIVE_BACKGROUND_KIND = "narrative-background";

/**
 * The Narrative seat's training set: every row of the run plus its second looks, newest first.
 * Trained on the deep-read rows alone it ranked those same moments clearly worse (walk-forward
 * AUC 0.65 vs 0.68 on 2026-10-08 production rows; user decision 2026-10-08 to train on every
 * row). It still decides only with the deep read in hand, so it is graded and calibrated only on
 * rows that carry it: every row without it (nsDepthFull != 1) becomes NARRATIVE_BACKGROUND_KIND.
 */
export function narrativeTrainingSet(
  rows: readonly TrainingRow[],
  seconds: readonly TrainingRow[],
): TrainingRow[] {
  const rest = rows.map((r) =>
    r.features.nsDepthFull === 1 ? r : { ...r, sampleKind: NARRATIVE_BACKGROUND_KIND },
  );
  return [...seconds, ...rest].sort((a, b) => b.anchorAt.getTime() - a.anchorAt.getTime());
}

/** A learner's exam, packaged: its stored result plus the rank arrays the consensus stacks on. */
interface LearnerExam {
  result: ContestantTrainingResult;
  examScore: number | null;
  evaluation: WalkForwardResult;
  /** Out-of-sample fold probabilities and the shipped model's probabilities, per reference row. */
  foldRanks: Float64Array | null;
  shipped: Float64Array | null;
  /**
   * 1 where the exam sent this model's call, per reference row: its fold's own cutoff and the
   * cooldown, the calls its exam record counts (WalkForwardResult.examCalls). Null when it sent
   * none.
   */
  calls: Uint8Array | null;
  /** That rank cutoff (null when the exam set none) - what the combiners count a call against. */
  callRank: number | null;
}

/** A learner's exam before it ships: what a challenger is scored and compared on. */
interface LearnerTrial {
  trial: RecipeTrial;
  record: CallRecord;
  examScore: number | null;
  /** Whether its reference rows line up one to one with the run's (see sitLearnerExam). */
  aligned: boolean;
  calls: Uint8Array | null;
}

async function sitLearnerExam(
  rows: TrainingRow[],
  cfg: ContestTrainingConfig,
  recipe: CuratorRecipe,
  reference: TrainingRow[] | null,
  usable: ReadonlySet<string> | null,
): Promise<LearnerTrial> {
  const trial = await sitRecipeExam(rows, cfg, recipe, usable);
  const { evaluation } = trial;
  const record = foldsRecord(evaluation.folds, "model");
  // Every learner's exam cuts the same rows into the same folds, so their reference rows (and
  // so their rank arrays) line up one to one; checked rather than assumed.
  const ref = reference ?? evaluation.decisionReference;
  const aligned =
    ref.length > 0 &&
    evaluation.decisionReference.length === ref.length &&
    evaluation.decisionReference.every((r, i) => r === ref[i]);
  return {
    trial,
    record,
    examScore: recordScore(record, cfg.targets),
    aligned,
    calls: aligned && evaluation.examCalls.some((c) => c === 1) ? evaluation.examCalls : null,
  };
}

async function shipLearner(
  rows: TrainingRow[],
  cfg: ContestTrainingConfig,
  slot: string,
  name: string,
  sat: LearnerTrial,
): Promise<LearnerExam> {
  const exam = await shipRecipe(rows, cfg, sat.trial);
  const { evaluation, trained, deployedThreshold } = exam;
  const verdict = verdictWithCutoff(exam);
  const { record, aligned } = sat;
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
      learner: sat.trial.recipe.learner,
      precisionCalibration: exam.result.precisionCalibration,
      precisionCurve: precisionCurve(evaluation.outOfSampleRanks),
      heuristicPrecisionCurve: [],
      exam: record,
      ...(exam.highConviction ? { highConviction: exam.highConviction } : {}),
      calibrationCalls: exam.extras.calibration?.calls ?? 0,
      examPopulation: evaluation.population,
      // What the seat's half-life did on the rows the shipped model trained on (the full window).
      trainingWeightByAge: trainingWeightByAge(rows, {
        recencyHalfLifeDays: sat.trial.recencyHalfLifeDays,
        legacyLabelWeight: cfg.legacyLabelWeight,
        runWeightPerDoubling: cfg.runWeightPerDoubling,
      }),
    },
  };
  const rankCutoff = exam.result.precisionCalibration.threshold;
  return {
    result,
    examScore: sat.examScore,
    evaluation,
    foldRanks: aligned ? Float64Array.from(evaluation.outOfSampleRanks, (c) => c.probability) : null,
    shipped: aligned ? exam.shippedProbabilities : null,
    calls: sat.calls,
    callRank: rankCutoff,
  };
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
  return shipLearner(rows, cfg, slot, name, await sitLearnerExam(rows, cfg, recipe, reference, usable));
}

/**
 * The exam evidence behind a takeover decision: every side's calls over the SAME reference rows,
 * so a challenger and a lane can be compared pairwise (see pairedBootstrapConfidence).
 */
export interface ExamEvidence {
  /** The reference rows' labels, in reference order. */
  labels: Float64Array;
  /** Each reference row's run size in doublings (runDoublings), in reference order. */
  runs: Float64Array;
  /** Each reference row's 10x tier: 1 hit, 0 miss, -1 not settled (never counted), in reference order. */
  tenX: Int8Array;
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
  /**
   * When true, a takeover this run decides does not take the seat: it comes back as
   * ContestRunOutcome.probation, to be confirmed on decision moments that arrive later
   * (curation/probation.ts).
   */
  probation?: boolean;
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
  /**
   * With a probation plan: the takeover this run decided, held back. Both models are frozen as
   * they stand now - the challenger's and the seat's - to be scored later on fresh rows.
   */
  probation: ProbationStart | null;
  /** A takeover the rule decided that this run could not carry out, and why (for the run log). */
  dropped: string | null;
}

export interface ProbationStart extends Replacement {
  bred: Challenger;
  examScore: number | null;
  challengerParams: ContestantParams;
  /** The seat's model from this same run, and the name it ran under. */
  laneParams: ContestantParams;
  laneName: string;
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
  storedRows: TrainingRow[],
  cfg: ContestTrainingConfig,
  plan?: EvolutionPlan,
): Promise<ContestRunOutcome> {
  // Every seat but the narrative ones learns TokenSage's read only from rows where it arrived
  // as it does live (see withCurrentNarrativeTiming); the narrative seats read storedRows.
  const rows = withCurrentNarrativeTiming(storedRows);
  const results: ContestantTrainingResult[] = [];
  const foldRanks = new Map<string, Float64Array>();
  const shippedProbabilities = new Map<string, Float64Array>();
  const laneExamScores = new Map<string, number | null>();
  let reference: TrainingRow[] | null = null;
  let rulesEvidence: { folds: EvalFold[]; heuristicOutOfSample: ScoredOutcome[] } | null = null;

  const laneCalls = new Map<string, Uint8Array>();
  const callRanks = new Map<string, number | null>();
  const keep = (slot: string, exam: LearnerExam) => {
    if (exam.foldRanks && exam.shipped) {
      foldRanks.set(slot, exam.foldRanks);
      shippedProbabilities.set(slot, exam.shipped);
      callRanks.set(slot, exam.callRank);
    } else {
      foldRanks.delete(slot);
      shippedProbabilities.delete(slot);
      callRanks.delete(slot);
    }
    if (exam.calls) laneCalls.set(slot, exam.calls);
    else laneCalls.delete(slot);
  };
  // Measured once, on the rows every learner's exam grades: the inputs' health this run.
  let featureReport: FeatureReport | null = null;
  // Over every training row, not just the exam's: winners with a finished run are few.
  const runnerReport = runnerTraitsReport(rows);
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
    exam.result.metrics.runnerReport = runnerReport;
    Object.assign(exam.result.metrics, heldFeatures);
    results.push(exam.result);
    laneExamScores.set(spec.id, exam.examScore);
    keep(spec.id, exam);
  }

  // The narrative seats sit their own exam, graded on the rows with the deep read: a seat on a
  // different population shares no fold with the learners, so it feeds no combiner and breeds
  // nothing. Skipped, with its running model kept, until it has rows enough.
  const narrativeSpecs = cfg.contestants.filter((c) => c.role === "narrative" && c.recipe);
  const own = narrativeSpecs.length > 0 ? narrativeTrainingSet(storedRows, cfg.narrativeRows ?? []) : [];
  const deepRead = own.filter((r) => r.sampleKind !== NARRATIVE_BACKGROUND_KIND);
  if (deepRead.length >= NARRATIVE_MIN_ROWS) {
    // Inputs judged on the deep-read rows: across every row the TokenSage inputs are young and
    // the onset guard would hold them, taking from the seats the very read they wait for.
    const ownFeatures = runFeatures(deepRead, cfg);
    const runnerReport = runnerTraitsReport(deepRead);
    for (const spec of narrativeSpecs) {
      const exam = await examineLearner(own, cfg, spec.id, spec.name, spec.recipe!, null, ownFeatures.usable);
      exam.result.metrics.runnerReport = runnerReport;
      if (cfg.featureOnsetGuard) exam.result.metrics.heldFeatures = ownFeatures.held;
      results.push(exam.result);
    }
  }

  const challengerScores: (number | null)[] = [];
  const challengerCalls: (Uint8Array | null)[] = [];
  const challengerExamWins: number[] = [];
  // Challengers only sit the exam: the model the winner ships is fitted below, once a takeover
  // (or probation) actually needs it, rather than three discarded fits per loser.
  let bestChallenger: { index: number; trial: LearnerTrial } | null = null;
  for (const [i, bred] of (plan?.challengers ?? []).entries()) {
    const trial = await sitLearnerExam(rows, cfg, bred.recipe, reference, features.usable);
    challengerScores.push(trial.examScore);
    challengerCalls.push(trial.calls);
    challengerExamWins.push(trial.record.wins);
    if (
      trial.examScore !== null &&
      (bestChallenger === null || trial.examScore > bestChallenger.trial.examScore!)
    ) {
      bestChallenger = { index: i, trial };
    }
  }
  const shipBest = (best: { index: number; trial: LearnerTrial }) =>
    shipLearner(rows, cfg, "", plan!.challengers[best.index]!.name, best.trial);
  let replacement: ContestRunOutcome["replacement"] = null;
  let probation: ContestRunOutcome["probation"] = null;
  let dropped: string | null = null;
  const decided =
    plan && challengerScores.length > 0
      ? plan.decide(laneExamScores, challengerScores, {
          labels: Float64Array.from(reference ?? [], (r) => r.labelValue),
          runs: Float64Array.from(reference ?? [], (r) => runDoublings(r)),
          tenX: Int8Array.from(reference ?? [], (r) =>
            r.labelValue <= 0 ? 0 : r.hit10x === undefined ? -1 : r.hit10x ? 1 : 0,
          ),
          laneCalls,
          challengerCalls,
          challengerExamWins,
        })
      : null;
  if (decided && (!bestChallenger || decided.challenger !== bestChallenger.index)) {
    // Only the best exam is kept between challengers (memory), so a rule that picks another one
    // can't be carried out; say so rather than drop it silently.
    dropped =
      bestChallenger === null
        ? `takeover of ${decided.slot} decided, but no challenger set a cutoff this run`
        : `takeover of ${decided.slot} decided for challenger ${decided.challenger}, not the best exam (${bestChallenger.index})`;
  } else if (decided && bestChallenger && plan?.probation) {
    const seat = results.find((r) => r.contestant === decided.slot);
    if (seat) {
      const exam = await shipBest(bestChallenger);
      probation = {
        ...decided,
        bred: plan.challengers[decided.challenger]!,
        examScore: exam.examScore,
        challengerParams: exam.result.params,
        laneParams: seat.params,
        laneName: seat.metrics.contestantName ?? decided.slot,
      };
    } else dropped = `takeover of ${decided.slot} decided, but that seat didn't train this run`;
  } else if (decided && bestChallenger) {
    const slot = decided.slot;
    const seat = results.findIndex((r) => r.contestant === slot);
    if (seat === -1) dropped = `takeover of ${slot} decided, but that seat didn't train this run`;
    else {
      const exam = await shipBest(bestChallenger);
      results[seat] = {
        contestant: slot,
        params: exam.result.params,
        metrics: {
          ...exam.result.metrics,
          contestant: slot,
          ...(featureReport ? { featureReport } : {}),
          runnerReport,
          ...heldFeatures,
        },
      };
      keep(slot, exam);
      replacement = { ...decided, bred: plan!.challengers[decided.challenger]!, examScore: exam.examScore };
    }
  }

  const rulesSpec = cfg.contestants.find((c) => c.role === "rules");
  if (rulesSpec && rulesEvidence) {
    results.push(
      rulesSeatResult(rulesSpec, cfg, rulesEvidence, {
        reference: reference ?? [],
        foldRanks,
        laneExamScores,
        names: new Map(results.map((r) => [r.contestant, r.metrics.contestantName ?? r.contestant])),
        replacedSlot: replacement?.slot ?? null,
        usable: features.usable,
      }),
    );
  }

  const stackedSpec = cfg.contestants.find((c) => c.role === "stacked");
  if (stackedSpec && reference !== null && foldRanks.size >= 2) {
    const stacked = await trainStackedCurator(
      {
        reference,
        memberFoldRanks: foldRanks,
        memberShippedProbabilities: shippedProbabilities,
        memberCallRanks: callRanks,
        heuristicMinScore: cfg.heuristicMinScore,
        targets: cfg.targets,
        cooldownHours: cfg.cooldownHours,
        targetPerHour: cfg.targetPerHour,
        recencyHalfLifeDays: cfg.recencyHalfLifeDays,
        runWeightPerDoubling: cfg.runWeightPerDoubling,
      },
      NEVER_EMIT_THRESHOLD,
    );
    if (stacked) {
      const served = servedExtras(
        cfg,
        stacked.outOfSample,
        stacked.shippedProbabilities,
        (rank) => probabilityAtRank(stacked.shippedProbabilities, rank),
        stacked.precisionCalibration.threshold,
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
      // The blend's cutoff is a blend score; in percentile units it is the share of scores below it.
      const blendCutoff = blend.precisionCalibration.threshold;
      const served = servedExtras(
        cfg,
        blend.outOfSample.map((c, i) => ({ ...c, probability: blendPercentiles[i]! })),
        blendScores,
        (rank) => probabilityAtRank(blendScores, rank),
        blendCutoff === null ? null : blendScores.filter((p) => p < blendCutoff).length / blendScores.length,
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

  const agreementSpec = cfg.contestants.find((c) => c.role === "agreement");
  if (agreementSpec && reference !== null && foldRanks.size >= 2) {
    const agreement = trainAgreementCurator(
      {
        reference,
        memberFoldRanks: foldRanks,
        memberShippedProbabilities: shippedProbabilities,
        memberCallRanks: callRanks,
        targets: cfg.targets,
        cooldownHours: cfg.cooldownHours,
        targetPerHour: cfg.targetPerHour,
      },
      NEVER_EMIT_THRESHOLD,
    );
    if (agreement) {
      // Agreement scores bunch at each member count, so like the blend's they become their own
      // percentiles for the tier line and the calibration (see the blend above).
      const scores = agreement.outOfSample.map((c) => c.probability);
      const percentiles = confidenceRanks(scores);
      const cutoff = agreement.precisionCalibration.threshold;
      const served = servedExtras(
        cfg,
        agreement.outOfSample.map((c, i) => ({ ...c, probability: percentiles[i]! })),
        scores,
        (rank) => probabilityAtRank(scores, rank),
        cutoff === null ? null : scores.filter((p) => p < cutoff).length / scores.length,
      );
      const judged = agreement.curve.filter((p) => p.rows > 0);
      const curveText = judged.map((p) => `${p.agreeing}: ${p.wins}/${p.rows}`).join(", ");
      results.push({
        contestant: agreementSpec.id,
        params: { ...agreement.params, ...served.extras },
        metrics: {
          contestant: agreementSpec.id,
          contestantName: agreementSpec.name,
          folds: [],
          verdict: {
            promote: false,
            reason: `${agreementSpec.name}: ${agreement.params.members.length} models' calls counted, judged on ${agreement.examChunks} chunk(s) of their out-of-sample calls; wins by models agreeing - ${curveText}`,
          },
          targets: cfg.targets,
          precisionCalibration: agreement.precisionCalibration,
          precisionCurve: agreement.precisionCurve,
          heuristicPrecisionCurve: [],
          exam: agreement.exam,
          agreementCurve: agreement.curve,
          ...(served.highConviction ? { highConviction: served.highConviction } : {}),
          calibrationCalls: served.extras.calibration?.calls ?? 0,
        },
      });
    }
  }

  const topSliceSpec = cfg.contestants.find((c) => c.role === "topslice");
  if (topSliceSpec && reference !== null) {
    const topSlice = trainTopSliceCurator({
      reference,
      memberFoldRanks: foldRanks,
      memberShippedProbabilities: shippedProbabilities,
      memberCallRanks: callRanks,
      targets: cfg.targets,
      cooldownHours: cfg.cooldownHours,
      targetPerHour: cfg.targetPerHour,
    });
    if (topSlice) {
      const names = topSlice.params.members.map(
        (m) => cfg.contestants.find((c) => c.id === m.contestant)?.name ?? m.contestant,
      );
      results.push({
        contestant: topSliceSpec.id,
        params: topSlice.params,
        metrics: {
          contestant: topSliceSpec.id,
          contestantName: topSliceSpec.name,
          folds: [],
          verdict: {
            promote: false,
            reason: `${topSliceSpec.name}: the top quarter of ${names.join(", ")}'s own calls, judged on their out-of-sample calls - ${topSlice.exam.wins}/${topSlice.exam.graded} doubled`,
          },
          targets: cfg.targets,
          precisionCalibration: topSlice.precisionCalibration,
          precisionCurve: [],
          heuristicPrecisionCurve: [],
          exam: topSlice.exam,
        },
      });
    }
  }

  // Roster order, so storage and logs read the same way the leaderboard lists them.
  const order = new Map(cfg.contestants.map((c, i) => [c.id, i]));
  results.sort((a, b) => order.get(a.contestant)! - order.get(b.contestant)!);
  return { results, challengerScores, replacement, probation, dropped };
}

/** The learners' exam evidence the Rules seat can learn from (see rulesSeatResult). */
interface RulesTeacherPool {
  /** The exam's decision moments, fold after fold. */
  reference: TrainingRow[];
  /** Per learner seat, its out-of-sample rank on each reference row. */
  foldRanks: ReadonlyMap<string, Float64Array>;
  laneExamScores: ReadonlyMap<string, number | null>;
  /** Seat -> the name it trained under this run. */
  names: ReadonlyMap<string, string>;
  /** A seat taken over this run: its ranks are the newcomer's, not the record that earned it the lead. */
  replacedSlot: string | null;
  usable: ReadonlySet<string> | null;
}

/** The seat to learn the rules from: the first named teacher examined this run, else the best exam. */
function pickRulesTeacher(cfg: ContestTrainingConfig, pool: RulesTeacherPool): string | null {
  const eligible = (slot: string) => slot !== pool.replacedSlot && pool.foldRanks.has(slot);
  for (const slot of cfg.rulesTeachers ?? []) if (eligible(slot)) return slot;
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [slot, score] of pool.laneExamScores) {
    if (eligible(slot) && score !== null && score > bestScore) {
      best = slot;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The Rules seat's result for this run. The hand-tuned gates get their cutoff from the exam as
 * always; with CURATOR_RULES_FROM_BEST on, a points table is also learned from the best model
 * (curation/rulesDistill.ts) and graded on the same exam beside the table the seat already runs.
 * The seat keeps what it runs unless another option's exam scores strictly higher - ties keep
 * the incumbent, so the rules don't churn on noise - and a table needs a cutoff to call at.
 */
function rulesSeatResult(
  spec: ContestantSpec,
  cfg: ContestTrainingConfig,
  evidence: { folds: EvalFold[]; heuristicOutOfSample: ScoredOutcome[] },
  pool: RulesTeacherPool,
): ContestantTrainingResult {
  const cooldown = { cooldownMs: cfg.cooldownHours * 3_600_000 };
  const handCalibration = calibrateThresholdForPrecision(
    evidence.heuristicOutOfSample,
    cfg.targets,
    cooldown,
  );
  const handCurve = precisionCurve(evidence.heuristicOutOfSample);
  const handExam = foldsRecord(evidence.folds, "heuristic");
  const hand: ContestantTrainingResult = {
    contestant: spec.id,
    params: {
      kind: RULES_MODEL_KIND,
      minScore: cfg.heuristicMinScore,
      rankCutoff: cfg.heuristicPrecisionGate ? handCalibration.threshold : null,
    },
    metrics: {
      contestant: spec.id,
      contestantName: spec.name,
      folds: evidence.folds,
      verdict: { promote: false, reason: `${spec.name}: the hand-tuned gate, held to its own cutoff` },
      targets: cfg.targets,
      precisionCalibration: handCalibration,
      precisionCurve: handCurve,
      ...(handCalibration.threshold !== null ? { heuristicCalibration: handCalibration } : {}),
      heuristicPrecisionCurve: handCurve,
      exam: handExam,
    },
  };
  if (!cfg.rulesFromBest) return hand;

  interface Option {
    label: string;
    result: ContestantTrainingResult;
    examScore: number | null;
    set: DerivedRuleSet | null;
  }
  const examTable = (set: DerivedRuleSet, label: string): Option | null => {
    const scores = pool.reference.map((r) => scoreRuleSet(set, r.features));
    const exam = examineRuleScores(
      pool.reference,
      evidence.folds,
      scores.map((s) => (s > 0 ? s : null)),
      cfg,
    );
    if (exam === null) return null;
    const calibration = calibrateThresholdForPrecision(exam.outOfSample, cfg.targets, cooldown);
    // A table with nowhere to send from can't hold the seat: Rules has to keep calling.
    if (calibration.threshold === null) return null;
    const curve = precisionCurve(exam.outOfSample);
    return {
      label,
      set,
      examScore: recordScore(exam.record, cfg.targets),
      result: {
        contestant: spec.id,
        params: {
          kind: RULES_MODEL_KIND,
          minScore: cfg.heuristicMinScore,
          rankCutoff: calibration.threshold,
          derived: set,
        },
        metrics: {
          contestant: spec.id,
          contestantName: spec.name,
          folds: evidence.folds,
          verdict: {
            promote: false,
            reason: `${spec.name}: ${set.conditions.length} checks learned from ${set.teacher.name}, held to their own cutoff`,
          },
          targets: cfg.targets,
          precisionCalibration: calibration,
          precisionCurve: curve,
          heuristicPrecisionCurve: [],
          exam: exam.record,
        },
      },
    };
  };

  const handOption: Option = {
    label: "hand-tuned rules",
    result: hand,
    examScore: recordScore(handExam, cfg.targets),
    set: null,
  };
  const current = cfg.currentRules
    ? examTable(cfg.currentRules, `current rules (from ${cfg.currentRules.teacher.name})`)
    : null;
  let fresh: Option | null = null;
  const teacher = pickRulesTeacher(cfg, pool);
  if (teacher !== null && pool.reference.length > 0) {
    const ranks = pool.foldRanks.get(teacher)!;
    const featureNames = LEARNER_FEATURE_NAMES.filter((f) => pool.usable === null || pool.usable.has(f));
    const conditions = distillRuleSet(pool.reference, ranks, featureNames);
    if (conditions) {
      const name = pool.names.get(teacher) ?? teacher;
      const set: DerivedRuleSet = {
        conditions,
        teacher: { contestant: teacher, name },
        derivedAt: new Date().toISOString(),
        agreementPct: teacherAgreementPct(
          ranks,
          pool.reference.map((r) => scoreRuleSet({ conditions }, r.features)),
        ),
      };
      fresh = examTable(set, `new rules from ${name}`);
    }
  }

  // The incumbent: the table the seat runs, while it can still call; else the hand-tuned gates.
  const incumbent = current ?? handOption;
  const challengers = [current ? handOption : null, fresh].filter((o): o is Option => o !== null);
  let chosen = incumbent;
  for (const option of challengers) {
    if (option.examScore !== null && (chosen.examScore === null || option.examScore > chosen.examScore)) {
      chosen = option;
    }
  }
  const options = [incumbent, ...challengers].map((o) => ({ label: o.label, examScore: o.examScore }));
  const fmt = (score: number | null) => (score === null ? "no graded calls" : score.toFixed(1));
  const reason =
    chosen === incumbent
      ? cfg.currentRules && !current
        ? `The learned rules found nowhere to call this run, so Rules went back to the hand-tuned gates (exam ${fmt(handOption.examScore)}).`
        : `Kept the ${incumbent.label} (exam ${fmt(incumbent.examScore)})` +
          (challengers.length > 0
            ? `: ${challengers.map((c) => `${c.label} scored ${fmt(c.examScore)}`).join(", ")}.`
            : teacher === null
              ? ": no trained model to learn from this run."
              : ": couldn't learn a usable table this run.")
      : `Switched to the ${chosen.label} (exam ${fmt(chosen.examScore)}, beating the ${incumbent.label} at ${fmt(incumbent.examScore)}).`;
  const set = chosen.set;
  const rulesInUse: RulesInUse = set
    ? {
        source: "learned",
        lines: describeRuleSet(set),
        teacher: set.teacher,
        derivedAt: set.derivedAt,
        agreementPct: set.agreementPct,
        changed: cfg.currentRules?.derivedAt !== set.derivedAt,
        options,
        reason,
      }
    : {
        source: "hand-tuned",
        lines: [...HAND_TUNED_RULE_LINES],
        changed: cfg.currentRules != null,
        options,
        reason,
      };
  return { ...chosen.result, metrics: { ...chosen.result.metrics, rulesInUse } };
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
