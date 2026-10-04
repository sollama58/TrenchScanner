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
  type UnthresholdedCuratorParams,
  type WalkForwardResult,
  type EvalFold,
  type ScoredOutcome,
  scoreCandidateWithModel,
} from "./trainer.js";
import {
  CONSENSUS_CONTESTANT,
  RULES_CONTESTANT,
  type ContestantSpec,
  type CuratorRecipe,
} from "./contestants.js";
import { emptyRecord, recordScore, type CallRecord } from "./leaderboard.js";
import type { Challenger, Replacement } from "./evolution.js";
import { trainStackedCurator, type StackedCuratorParams } from "./stacking.js";

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
  /** The contestant this row belongs to (contest runs only). */
  contestant?: string;
  /** The name it trained under - an evolving seat's name changes with its recipe. */
  contestantName?: string;
  /** The exam's governed call record - what the leaderboard scores before live calls exist. */
  exam?: CallRecord;
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
}

async function examineRecipe(
  rows: TrainingRow[],
  cfg: Omit<CuratorTrainingConfig, "learners">,
  recipe: CuratorRecipe,
): Promise<RecipeExam> {
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
  });
  // The targets are what the feed aims for, not a gate: when no cutoff met them, the model ships
  // at its best-effort cutoff (see chooseCutoff) and still competes on its exam. Only an exam
  // with no judgeable cutoff at all leaves it without one.
  const deployedThreshold =
    precisionCalibration.threshold === null
      ? null
      : thresholdAtRank(trained, evaluation.decisionReference, precisionCalibration.threshold);
  return {
    evaluation,
    result: { learner: recipe.learner, verdict: evaluation.verdict, precisionCalibration },
    trained,
    deployedThreshold,
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

  const exams: RecipeExam[] = [];
  for (const learner of cfg.learners) exams.push(await examineRecipe(rows, cfg, { learner }));
  const chosen = exams[pickCuratorFamily(exams.map((e) => e.result))]!;
  const { evaluation, trained, deployedThreshold } = chosen;
  const { learner, precisionCalibration } = chosen.result;

  // The hand-tuned heuristic gets its cutoff the same way while it holds the job. Its calls do not
  // depend on the model family, so any family's exam carries the same heuristic record.
  const heuristicCalibration = calibrateThresholdForPrecision(
    evaluation.heuristicOutOfSample,
    cfg.targets,
    cooldown,
  );
  const params = { ...trained, threshold: deployedThreshold ?? NEVER_EMIT_THRESHOLD } as TrainedCuratorParams;
  const verdict = verdictWithCutoff(chosen);
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

/** The rules contestant's stored "model": just the hit-rate cutoff its exam earned. */
export const RULES_MODEL_KIND = "rules-v1";

export interface RulesCuratorParams {
  kind: typeof RULES_MODEL_KIND;
  minScore: number;
  /** Rank-score cutoff, or null when the exam had no evidence for one (the gate stands alone). */
  rankCutoff: number | null;
}

export type ContestantParams = TrainedCuratorParams | StackedCuratorParams | RulesCuratorParams;

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
}

async function examineLearner(
  rows: TrainingRow[],
  cfg: ContestTrainingConfig,
  slot: string,
  name: string,
  recipe: CuratorRecipe,
  reference: TrainingRow[] | null,
): Promise<LearnerExam> {
  const exam = await examineRecipe(rows, cfg, recipe);
  const { evaluation, trained, deployedThreshold } = exam;
  const verdict = verdictWithCutoff(exam);
  const record = foldsRecord(evaluation.folds, "model");
  const result: ContestantTrainingResult = {
    contestant: slot,
    params: { ...trained, threshold: deployedThreshold ?? NEVER_EMIT_THRESHOLD } as TrainedCuratorParams,
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
    },
  };
  // Every learner's exam cuts the same rows into the same folds, so their reference rows (and
  // so their rank arrays) line up one to one; checked rather than assumed.
  const ref = reference ?? evaluation.decisionReference;
  const aligned =
    ref.length > 0 &&
    evaluation.decisionReference.length === ref.length &&
    evaluation.decisionReference.every((r, i) => r === ref[i]);
  return {
    result,
    examScore: recordScore(record, cfg.targets),
    evaluation,
    foldRanks: aligned ? Float64Array.from(evaluation.outOfSampleRanks, (c) => c.probability) : null,
    shipped: aligned ? Float64Array.from(ref, (r) => scoreCandidateWithModel(trained, r.features)) : null,
  };
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

  const keep = (slot: string, exam: LearnerExam) => {
    if (exam.foldRanks && exam.shipped) {
      foldRanks.set(slot, exam.foldRanks);
      shippedProbabilities.set(slot, exam.shipped);
    } else {
      foldRanks.delete(slot);
      shippedProbabilities.delete(slot);
    }
  };

  for (const spec of cfg.contestants) {
    if (spec.role !== "learner" || !spec.recipe) continue;
    const exam = await examineLearner(rows, cfg, spec.id, spec.name, spec.recipe, reference);
    if (reference === null) {
      reference = exam.evaluation.decisionReference;
      rulesEvidence = {
        folds: exam.evaluation.folds,
        heuristicOutOfSample: exam.evaluation.heuristicOutOfSample,
      };
    }
    results.push(exam.result);
    laneExamScores.set(spec.id, exam.examScore);
    keep(spec.id, exam);
  }

  const challengerScores: (number | null)[] = [];
  let bestChallenger: { index: number; exam: LearnerExam } | null = null;
  for (const [i, bred] of (plan?.challengers ?? []).entries()) {
    const exam = await examineLearner(rows, cfg, "", bred.name, bred.recipe, reference);
    challengerScores.push(exam.examScore);
    if (
      exam.examScore !== null &&
      (bestChallenger === null || exam.examScore > bestChallenger.exam.examScore!)
    ) {
      bestChallenger = { index: i, exam };
    }
  }
  let replacement: ContestRunOutcome["replacement"] = null;
  const decided = plan && challengerScores.length > 0 ? plan.decide(laneExamScores, challengerScores) : null;
  if (decided && bestChallenger && decided.challenger === bestChallenger.index) {
    const { exam } = bestChallenger;
    const slot = decided.slot;
    const seat = results.findIndex((r) => r.contestant === slot);
    if (seat !== -1) {
      results[seat] = {
        contestant: slot,
        params: exam.result.params,
        metrics: { ...exam.result.metrics, contestant: slot },
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
      results.push({
        contestant: stackedSpec.id,
        params: stacked.params,
        metrics: {
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
