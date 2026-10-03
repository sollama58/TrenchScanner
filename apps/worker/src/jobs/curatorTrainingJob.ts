import {
  prisma,
  createLogger,
  trainCurator,
  calibrateThresholdForPrecision,
  precisionCurve,
  walkForwardEvaluate,
  CURATOR_MODEL_KIND,
  type Env,
  type TrainingRow,
  type TrainedCuratorParams,
  type PrecisionCalibration,
  type PrecisionCurvePoint,
  type PrecisionTargets,
  type WalkForwardResult,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";

const logger = createLogger("curator-training");

/**
 * Below this many finalized rows there is nothing worth even evaluating - the job logs the count
 * (so the learning panel's "collecting data" phase has a number behind it) and comes back
 * tomorrow. Distinct from CURATOR_MIN_TRAINING_ROWS, which gates PROMOTION - between the two,
 * the job trains and records candidate models whose evaluations are visible but powerless.
 */
const MIN_ROWS_TO_TRAIN = 300;

/**
 * The threshold a model gets when no cutoff met the hit-rate targets: above any probability the
 * sigmoid can produce, so it sends nothing. A finite number on purpose - params are stored as
 * JSON, and Infinity would round-trip as null.
 */
export const NEVER_EMIT_THRESHOLD = 1.01;

/** What the training job stores as CuratorModel.evalMetrics: the exam plus the hit-rate evidence. */
export interface StoredEvalMetrics {
  folds: WalkForwardResult["folds"];
  verdict: WalkForwardResult["verdict"];
  targets: PrecisionTargets;
  precisionCalibration: PrecisionCalibration;
  precisionCurve: PrecisionCurvePoint[];
  /** The heuristic's hit-rate cutoff, in rank-score units - see heuristicCutoff in curatedAlerts.ts. */
  heuristicCalibration: PrecisionCalibration;
  heuristicPrecisionCurve: PrecisionCurvePoint[];
}

/**
 * The learner, run every CURATOR_TRAINING_INTERVAL_HOURS. Loads the rolling window of finalized
 * training rows, walk-forward evaluates the model family against the live heuristic on that same
 * history, trains the deployable model on the full window, and stores it all as one CuratorModel
 * row - active if the evaluation earned promotion, candidate otherwise. See applyTrainingResult
 * for how activation and fallback work; see packages/core/src/curation/trainer.ts for every piece
 * of math.
 */
export async function runCuratorTrainingJob(env: Env): Promise<void> {
  const startedAt = Date.now();
  const windowStart = new Date(startedAt - env.CURATOR_TRAINING_WINDOW_DAYS * 86_400_000);

  const rows = await prisma.candidateOutcome.findMany({
    // Emission rows exist because a curator picked them; training on them would feed the
    // curators' own choices back into the next model (see CandidateOutcome.sampleKind).
    where: { finalizedAt: { not: null }, anchorAt: { gte: windowStart }, sampleKind: { not: "emission" } },
    select: {
      tokenId: true,
      anchorAt: true,
      features: true,
      labelValue: true,
      anchorPriceUsd: true,
      signalPriceUsd: true,
      anchorMcapUsd: true,
      sampleKind: true,
    },
  });
  if (rows.length < MIN_ROWS_TO_TRAIN) {
    logger.info("not enough finalized samples to train yet", {
      rows: rows.length,
      needed: MIN_ROWS_TO_TRAIN,
    });
    return;
  }

  const trainingRows: TrainingRow[] = rows.map((r) => ({
    tokenId: r.tokenId,
    anchorAt: r.anchorAt,
    features: r.features as Record<string, number | null>,
    labelValue: r.labelValue ?? 0,
    // The price the features were observed at - the fill the label is graded from comes later.
    anchorPriceUsd: r.signalPriceUsd ?? r.anchorPriceUsd,
    anchorMcapUsd: r.anchorMcapUsd,
    sampleKind: r.sampleKind,
  }));

  const mcapBand = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
  const evaluation = await walkForwardEvaluate(trainingRows, {
    targetPerHour: env.CURATED_TARGET_PER_HOUR,
    heuristicMinScore: env.CURATED_MIN_SCORE,
    // Emission enforces the band before either curator runs (see maybeEmitCuratedAlert), so the
    // exam has to as well - otherwise it grades emissions production never makes.
    mcapBand,
    minRowsToPromote: env.CURATOR_MIN_TRAINING_ROWS,
    recencyHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
    // Graded and calibrated on event rows only - the moments live curators actually decide on.
    decisionRowsOnly: true,
    cooldownHours: env.CURATED_ALERT_COOLDOWN_HOURS,
  });

  // The deployable model trains on the FULL window - the walk-forward folds were the exam, this
  // is the model that actually ships, with strictly more (and newer) data than any fold saw.
  // Out-of-band samples still teach (mcap is a feature).
  const trained = await trainCurator(trainingRows, {
    recencyHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
  });

  // Its cutoff is set by HIT RATE, from the exam's out-of-sample calls (in-band only - the only
  // rows it will ever be applied to): the lowest confidence at which those calls met the targets.
  // When none did, the model sends nothing and cannot take the job - a model that can't reach
  // the bar on history it never saw has no business vouching for live tokens.
  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
  };
  // Both cutoffs replay the per-token cooldown, so their support counts alerts the feed would
  // actually have sent rather than every hourly sample of a token that stayed hot.
  const cooldown = { cooldownMs: env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000 };
  const precisionCalibration = calibrateThresholdForPrecision(evaluation.outOfSample, targets, cooldown);
  // The hand-tuned heuristic is held to the same bar while it holds the job: its rank-score
  // cutoff comes from its own out-of-sample record (see heuristicOutOfSample). Read at emission
  // time by curatedAlerts.ts from the newest CuratorModel row's evalMetrics.
  const heuristicCalibration = calibrateThresholdForPrecision(
    evaluation.heuristicOutOfSample,
    targets,
    cooldown,
  );
  const params: TrainedCuratorParams = {
    ...trained,
    threshold: precisionCalibration.threshold ?? NEVER_EMIT_THRESHOLD,
  };
  const verdict =
    evaluation.verdict.promote && precisionCalibration.threshold === null
      ? {
          promote: false,
          reason: `${evaluation.verdict.reason.replace(" - promoting", "")}, but no cutoff reached ${env.CURATED_TARGET_WIN_RATE_PCT}% at 2x and ${env.CURATED_TARGET_GOAL_RATE_PCT}% at 4x - keeping current curator`,
        }
      : evaluation.verdict;
  const metrics: StoredEvalMetrics = {
    folds: evaluation.folds,
    verdict,
    targets,
    precisionCalibration,
    precisionCurve: precisionCurve(evaluation.outOfSample),
    heuristicCalibration,
    heuristicPrecisionCurve: precisionCurve(evaluation.heuristicOutOfSample),
  };

  const modelId = await applyTrainingResult(metrics, params, trainingRows.length, windowStart);

  logger.info("curator training complete", {
    durationMs: Date.now() - startedAt,
    rows: trainingRows.length,
    folds: evaluation.folds.length,
    promoted: verdict.promote,
    verdict: verdict.reason,
    threshold: params.threshold,
    calibration: precisionCalibration,
    heuristicCalibration,
    modelId,
  });
}

/**
 * Records the trained model and applies the verdict, atomically:
 *  - promote: any currently active model retires, the new one activates. The curator changes
 *    hands between two scan cycles, and the retired row remains as the audit trail.
 *  - no promote: the new model is stored as a candidate AND any currently active model retires
 *    too. That second part is deliberate: tonight's evaluation is the freshest evidence about
 *    this model family on this market, and it just said "does not beat the heuristic" - an old
 *    model staying live against newer contrary evidence is how feeds quietly rot. Fallback is
 *    the heuristic, which never rots because it never changes.
 */
export async function applyTrainingResult(
  evaluation: Pick<StoredEvalMetrics, "folds" | "verdict"> & Partial<StoredEvalMetrics>,
  params: TrainedCuratorParams,
  trainingRows: number,
  trainingFrom: Date,
): Promise<string> {
  const now = new Date();
  // The raw per-row exam evidence never goes into the row - it is one entry per training sample.
  const stored: Record<string, unknown> = { ...evaluation };
  delete stored.outOfSample;
  delete stored.heuristicOutOfSample;
  return prisma.$transaction(async (tx) => {
    await tx.curatorModel.updateMany({
      where: { status: "active" },
      data: { status: "retired", retiredAt: now },
    });
    const created = await tx.curatorModel.create({
      data: {
        kind: CURATOR_MODEL_KIND,
        params: params as unknown as Prisma.InputJsonValue,
        trainingRows,
        trainingFrom,
        trainingTo: now,
        evalMetrics: stored as Prisma.InputJsonValue,
        status: evaluation.verdict.promote ? "active" : "candidate",
        activatedAt: evaluation.verdict.promote ? now : null,
      },
    });
    return created.id;
  });
}
