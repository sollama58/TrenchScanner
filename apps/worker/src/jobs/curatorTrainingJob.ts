import {
  prisma,
  createLogger,
  trainCurator,
  calibrateThreshold,
  walkForwardEvaluate,
  CURATOR_MODEL_KIND,
  type Env,
  type TrainingRow,
  type TrainedCuratorParams,
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
 * The nightly learner. Loads the rolling window of finalized training rows, walk-forward
 * evaluates the model family against the live heuristic on that same history, trains the
 * deployable model on the full window, and stores it all as one CuratorModel row - active if the
 * evaluation earned promotion, candidate otherwise. See applyTrainingResult for how activation
 * and fallback work; see packages/core/src/curation/trainer.ts for every piece of math.
 */
export async function runCuratorTrainingJob(env: Env): Promise<void> {
  const startedAt = Date.now();
  const windowStart = new Date(startedAt - env.CURATOR_TRAINING_WINDOW_DAYS * 86_400_000);

  const rows = await prisma.candidateOutcome.findMany({
    where: { finalizedAt: { not: null }, anchorAt: { gte: windowStart } },
    select: {
      anchorAt: true,
      features: true,
      labelValue: true,
      anchorPriceUsd: true,
      anchorMcapUsd: true,
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
    anchorAt: r.anchorAt,
    features: r.features as Record<string, number | null>,
    labelValue: r.labelValue ?? 0,
    anchorPriceUsd: r.anchorPriceUsd,
    anchorMcapUsd: r.anchorMcapUsd,
  }));

  const evaluation = walkForwardEvaluate(trainingRows, {
    targetPerHour: env.CURATED_TARGET_PER_HOUR,
    heuristicMinScore: env.CURATED_MIN_SCORE,
    minRowsToPromote: env.CURATOR_MIN_TRAINING_ROWS,
  });

  // The deployable model trains on the FULL window - the walk-forward folds were the exam, this
  // is the model that actually ships, with strictly more (and newer) data than any fold saw.
  const trained = trainCurator(trainingRows);
  const params: TrainedCuratorParams = {
    ...trained,
    threshold: calibrateThreshold(trained, trainingRows, env.CURATED_TARGET_PER_HOUR),
  };

  const modelId = await applyTrainingResult(evaluation, params, trainingRows.length, windowStart);

  logger.info("curator training complete", {
    durationMs: Date.now() - startedAt,
    rows: trainingRows.length,
    folds: evaluation.folds.length,
    promoted: evaluation.verdict.promote,
    verdict: evaluation.verdict.reason,
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
  evaluation: WalkForwardResult,
  params: TrainedCuratorParams,
  trainingRows: number,
  trainingFrom: Date,
): Promise<string> {
  const now = new Date();
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
        evalMetrics: evaluation as unknown as Prisma.InputJsonValue,
        status: evaluation.verdict.promote ? "active" : "candidate",
        activatedAt: evaluation.verdict.promote ? now : null,
      },
    });
    return created.id;
  });
}
