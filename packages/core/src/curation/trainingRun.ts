import type { McapBand } from "./curator.js";
import {
  calibrateThresholdForPrecision,
  precisionCurve,
  thresholdAtRank,
  trainCuratorModel,
  walkForwardEvaluate,
  type CuratorLearner,
  type PrecisionCalibration,
  type PrecisionCurvePoint,
  type PrecisionTargets,
  type PromotionVerdict,
  type TrainedCuratorParams,
  type TrainingRow,
  type WalkForwardResult,
} from "./trainer.js";

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

export async function runCuratorTraining(
  rows: TrainingRow[],
  cfg: CuratorTrainingConfig,
): Promise<CuratorTrainingOutcome> {
  if (cfg.learners.length === 0) throw new Error("no curator model families enabled");
  const cooldown = { cooldownMs: cfg.cooldownHours * 3_600_000 };

  const exams: { learner: CuratorLearner; evaluation: WalkForwardResult; result: FamilyResult }[] = [];
  for (const learner of cfg.learners) {
    const evaluation = await walkForwardEvaluate(rows, {
      targetPerHour: cfg.targetPerHour,
      heuristicMinScore: cfg.heuristicMinScore,
      // Emission enforces the band before either curator runs (see maybeEmitCuratedAlert), so
      // the exam has to as well - otherwise it grades emissions production never makes.
      mcapBand: cfg.mcapBand,
      minRowsToPromote: cfg.minRowsToPromote,
      recencyHalfLifeDays: cfg.recencyHalfLifeDays,
      // Graded and calibrated on event rows only - the moments live curators actually decide on.
      decisionRowsOnly: true,
      cooldownHours: cfg.cooldownHours,
      // Both sides are graded at the hit-rate cutoffs production holds them to, not at a pace.
      targets: cfg.targets,
      heuristicPrecisionGate: cfg.heuristicPrecisionGate,
      learner,
    });
    // Calibrated in RANK units: each fold model and the shipped model put probabilities on their
    // own scales, so a raw probability that hit 75% on the fold models says nothing about the
    // same number on the shipped one. "The top r of decision moments" does carry over.
    const precisionCalibration = calibrateThresholdForPrecision(
      evaluation.outOfSampleRanks,
      cfg.targets,
      cooldown,
    );
    exams.push({
      learner,
      evaluation,
      result: { learner, verdict: evaluation.verdict, precisionCalibration },
    });
  }
  const chosen = exams[pickCuratorFamily(exams.map((e) => e.result))]!;
  const { evaluation, learner } = chosen;
  const precisionCalibration = chosen.result.precisionCalibration;

  // The deployable model trains on the FULL window - the folds were the exam, this is the model
  // that ships, with strictly more (and newer) data than any fold saw.
  const trained = await trainCuratorModel(rows, { recencyHalfLifeDays: cfg.recencyHalfLifeDays, learner });
  // The targets are what the feed aims for, not a gate: when no cutoff met them, the model ships
  // at its best-effort cutoff (see chooseCutoff) and still competes for the job on its exam.
  // Only an exam with no judgeable cutoff at all leaves it without one.
  const deployedThreshold =
    precisionCalibration.threshold === null
      ? null
      : thresholdAtRank(trained, evaluation.decisionReference, precisionCalibration.threshold);
  // The hand-tuned heuristic gets its cutoff the same way while it holds the job. Its calls do not
  // depend on the model family, so any family's exam carries the same heuristic record.
  const heuristicCalibration = calibrateThresholdForPrecision(
    evaluation.heuristicOutOfSample,
    cfg.targets,
    cooldown,
  );
  const params = { ...trained, threshold: deployedThreshold ?? NEVER_EMIT_THRESHOLD } as TrainedCuratorParams;
  const verdict =
    evaluation.verdict.promote && deployedThreshold === null
      ? {
          promote: false,
          reason: `${evaluation.verdict.reason.replace(" - promoting", "")}, but too few out-of-sample calls to set a cutoff - keeping current curator`,
        }
      : evaluation.verdict;
  const metrics: StoredEvalMetrics = {
    folds: evaluation.folds,
    verdict: exams.length > 1 ? { ...verdict, reason: `${learner}: ${verdict.reason}` } : verdict,
    targets: cfg.targets,
    learner,
    familyComparison: exams.map((e) => e.result),
    precisionCalibration,
    precisionCurve: precisionCurve(evaluation.outOfSampleRanks),
    // Stored only when there was evidence to set a cutoff from. Without it the heuristic keeps
    // sending on its gate alone (see heuristicGate in curatedAlerts.ts).
    ...(heuristicCalibration.threshold !== null ? { heuristicCalibration } : {}),
    heuristicPrecisionCurve: precisionCurve(evaluation.heuristicOutOfSample),
  };
  return { params, metrics, evaluation };
}
