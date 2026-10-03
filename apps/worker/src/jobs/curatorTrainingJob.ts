import {
  prisma,
  createLogger,
  runCuratorTraining,
  NEVER_EMIT_THRESHOLD,
  type Env,
  type TrainingRow,
  type TrainedCuratorParams,
  type PrecisionTargets,
  type StoredEvalMetrics,
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

// Moved to core (curation/trainingRun.ts) with the run logic; re-exported for existing callers.
export { NEVER_EMIT_THRESHOLD, type StoredEvalMetrics };

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

  const trainingRows = await loadTrainingRows(windowStart, env.CURATOR_TRAINING_MAX_ROWS);
  if (trainingRows.length < MIN_ROWS_TO_TRAIN) {
    logger.info("not enough finalized samples to train yet", {
      rows: trainingRows.length,
      needed: MIN_ROWS_TO_TRAIN,
    });
    return;
  }
  if (trainingRows.length >= env.CURATOR_TRAINING_MAX_ROWS) {
    logger.info("training on the newest samples only", {
      rows: trainingRows.length,
      oldestAnchorAt: trainingRows[trainingRows.length - 1]!.anchorAt,
    });
  }

  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  // Every enabled model family sits the same walk-forward exam; the one with the better
  // out-of-sample hit-rate record is trained on the full window and stored (see
  // runCuratorTraining in packages/core/src/curation/trainingRun.ts for all the math).
  const { params, metrics, evaluation } = await runCuratorTraining(trainingRows, {
    targets,
    targetPerHour: env.CURATED_TARGET_PER_HOUR,
    heuristicMinScore: env.CURATED_MIN_SCORE,
    mcapBand: { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX },
    minRowsToPromote: env.CURATOR_MIN_TRAINING_ROWS,
    recencyHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
    cooldownHours: env.CURATED_ALERT_COOLDOWN_HOURS,
    heuristicPrecisionGate: env.CURATED_HEURISTIC_PRECISION_GATE,
    learners: env.CURATOR_MODEL_FAMILIES,
  });
  const { verdict, precisionCalibration } = metrics;

  const modelId = await applyTrainingResult(metrics, params, trainingRows.length, windowStart);

  logger.info("curator training complete", {
    durationMs: Date.now() - startedAt,
    rows: trainingRows.length,
    folds: evaluation.folds.length,
    promoted: verdict.promote,
    verdict: verdict.reason,
    threshold: params.threshold,
    rankCutoff: precisionCalibration.threshold,
    calibration: precisionCalibration,
    heuristicCalibration: metrics.heuristicCalibration,
    learner: metrics.learner,
    families: metrics.familyComparison,
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
/** Rows fetched per query - keeps the driver's raw result for any one page small. */
const LOAD_PAGE_ROWS = 5_000;

/**
 * The newest `maxRows` finalized training rows in the window, newest first. Paged, so the
 * query engine's raw result is never the whole window at once - only the mapped rows accumulate.
 */
export async function loadTrainingRows(
  windowStart: Date,
  maxRows: number,
  pageRows = LOAD_PAGE_ROWS,
): Promise<TrainingRow[]> {
  const out: TrainingRow[] = [];
  let cursor: string | undefined;
  while (out.length < maxRows) {
    const page = await prisma.candidateOutcome.findMany({
      // Emission rows exist because a curator picked them, and match rows because a user's filter
      // did; training on either would teach the model someone's selection rather than the market
      // (see CandidateOutcome.sampleKind). Listed positively so a new kind stays out by default.
      where: {
        finalizedAt: { not: null },
        anchorAt: { gte: windowStart },
        sampleKind: { in: ["hourly", "event"] },
      },
      orderBy: [{ anchorAt: "desc" }, { id: "desc" }],
      take: Math.min(pageRows, maxRows - out.length),
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
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
    for (const r of page) {
      out.push({
        tokenId: r.tokenId,
        anchorAt: r.anchorAt,
        features: r.features as Record<string, number | null>,
        labelValue: r.labelValue ?? 0,
        // The price the features were observed at - the fill the label is graded from comes later.
        anchorPriceUsd: r.signalPriceUsd ?? r.anchorPriceUsd,
        anchorMcapUsd: r.anchorMcapUsd,
        sampleKind: r.sampleKind,
      });
    }
    if (page.length < pageRows) break;
    cursor = page[page.length - 1]!.id;
  }
  return out;
}

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
  delete stored.outOfSampleRanks;
  delete stored.decisionReference;
  return prisma.$transaction(async (tx) => {
    await tx.curatorModel.updateMany({
      where: { status: "active" },
      data: { status: "retired", retiredAt: now },
    });
    const created = await tx.curatorModel.create({
      data: {
        kind: params.kind,
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
