import {
  prisma,
  createLogger,
  breedChallengers,
  chooseReplacement,
  compositeScore,
  emptyRecord,
  enabledContestants,
  foundingLanes,
  liveCallRecords,
  loadCurrentLanes,
  runEvolvingContest,
  seededRng,
  withLanes,
  NEVER_EMIT_THRESHOLD,
  STACKED_MODEL_KIND,
  type ContestRunOutcome,
  type ContestantTrainingResult,
  type EvolutionPlan,
  type Lane,
  type LaneFitness,
  type StackedCuratorParams,
  type Env,
  type TrainingRow,
  type PrecisionTargets,
  type StoredEvalMetrics,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";

const logger = createLogger("curator-training");

/**
 * Below this many finalized rows there is nothing worth even evaluating - the job logs the count
 * (so the learning panel's "collecting data" phase has a number behind it) and comes back
 * at the next run.
 */
const MIN_ROWS_TO_TRAIN = 300;

/** The live window evolution judges seats on - the leaderboard's default window. */
const FITNESS_WINDOW_DAYS = 30;

// Moved to core (curation/trainingRun.ts) with the run logic; re-exported for existing callers.
export { NEVER_EMIT_THRESHOLD, type StoredEvalMetrics };

/**
 * The curator contest's training run, every CURATOR_TRAINING_INTERVAL_HOURS. Loads the rolling
 * window of finalized training rows, walk-forward examines every learner contestant on that same
 * history, trains each one's deployable model on the full window, stacks the consensus on their
 * out-of-sample calls, and stores one CuratorModel row per contestant (see applyContestResults).
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
  // The field as it stands: each learner seat trains its current lane's recipe. Seats that have
  // never had a lane stored (first run after the evolution deploy) start from their founding
  // recipe, stored with this run.
  const now = new Date(startedAt);
  const stored = await loadCurrentLanes();
  const roster = enabledContestants(env.CURATOR_CONTESTANTS);
  const storedSlots = new Set(stored.map((l) => l.slot));
  const founding = foundingLanes(roster, now).filter((l) => !storedSlots.has(l.slot));
  const lanes = [...stored, ...founding].filter((l) => roster.some((s) => s.id === l.slot));
  const contestants = withLanes(roster, lanes);

  const plan = await evolutionPlan(env, lanes, targets, now);
  // Every learner contestant sits the same walk-forward exam and ships its own model at its own
  // cutoff; challengers sit it too; the consensus is stacked on the final lineup's out-of-sample
  // calls (see runEvolvingContest in packages/core/src/curation/trainingRun.ts for all the math).
  const outcome = await runEvolvingContest(
    trainingRows,
    {
      targets,
      targetPerHour: env.CURATED_TARGET_PER_HOUR,
      heuristicMinScore: env.CURATED_MIN_SCORE,
      mcapBand: { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX },
      minRowsToPromote: env.CURATOR_MIN_TRAINING_ROWS,
      recencyHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
      cooldownHours: env.CURATED_ALERT_COOLDOWN_HOURS,
      heuristicPrecisionGate: env.CURATED_HEURISTIC_PRECISION_GATE,
      contestants,
    },
    plan ?? undefined,
  );
  const { results } = outcome;
  if (results.length === 0) {
    logger.info("contest training produced nothing to store", { rows: trainingRows.length });
    return;
  }

  const modelIds = await applyContestResults(results, trainingRows.length, windowStart, {
    founding,
    replacement: outcome.replacement,
  });

  if (plan) {
    logger.info("curator evolution", {
      challengers: plan.challengers.map((c, i) => ({
        name: c.name,
        parent: c.parentName,
        examScore: outcome.challengerScores[i] ?? null,
      })),
      takeover: outcome.replacement
        ? {
            slot: outcome.replacement.slot,
            name: outcome.replacement.bred.name,
            reason: outcome.replacement.reason,
          }
        : null,
    });
  }
  logger.info("curator contest training complete", {
    durationMs: Date.now() - startedAt,
    rows: trainingRows.length,
    contestants: results.map((r) => ({
      contestant: r.contestant,
      modelId: modelIds.get(r.contestant),
      threshold: "threshold" in r.params ? r.params.threshold : null,
      calibration: r.metrics.precisionCalibration,
      exam: r.metrics.exam,
    })),
  });
}

/**
 * Stores one run's contestants atomically: every currently active or candidate model retires
 * (whatever generation - single-curator rows from before the contest too) and the run's rows go
 * live, one per contestant. The consensus row is written last, with its members' new row ids, so
 * the roster can check it is reading the generation it was stacked on. Returns contestant -> id.
 */
export async function applyContestResults(
  results: ContestantTrainingResult[],
  trainingRows: number,
  trainingFrom: Date,
  evolution: { founding?: Lane[]; replacement?: ContestRunOutcome["replacement"] } = {},
): Promise<Map<string, string>> {
  const now = new Date();
  // The consensus references its members, so it goes after them.
  const ordered = [...results].sort(
    (a, b) => Number(a.params.kind === STACKED_MODEL_KIND) - Number(b.params.kind === STACKED_MODEL_KIND),
  );
  return prisma.$transaction(async (tx) => {
    // Lanes first: the seats' recipes as of this run, in the same transaction as the models they
    // trained, so a lane and its seat's active model always change together.
    for (const lane of evolution.founding ?? []) {
      await tx.curatorLane.create({ data: laneData(lane, null) });
    }
    const replacement = evolution.replacement;
    if (replacement) {
      await tx.curatorLane.updateMany({
        where: { slot: replacement.slot, retiredAt: null },
        data: {
          retiredAt: now,
          retiredReason: `Replaced by ${replacement.bred.name}: ${replacement.reason}`,
        },
      });
      await tx.curatorLane.create({
        data: laneData(
          {
            slot: replacement.slot,
            name: replacement.bred.name,
            description: replacement.bred.description,
            recipe: replacement.bred.recipe,
            generation: replacement.bred.generation,
            parentName: replacement.bred.parentName,
            bornAt: now,
          },
          replacement.examScore,
        ),
      });
    }
    await tx.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: now },
    });
    const ids = new Map<string, string>();
    for (const result of ordered) {
      let params = result.params;
      if (params.kind === STACKED_MODEL_KIND) {
        const stacked = params as StackedCuratorParams;
        params = {
          ...stacked,
          members: stacked.members.map((m) => ({ ...m, modelId: ids.get(m.contestant) ?? "" })),
        };
      }
      const created = await tx.curatorModel.create({
        data: {
          contestant: result.contestant,
          kind: params.kind,
          params: params as unknown as Prisma.InputJsonValue,
          trainingRows,
          trainingFrom,
          trainingTo: now,
          evalMetrics: result.metrics as unknown as Prisma.InputJsonValue,
          status: "active",
          activatedAt: now,
        },
        select: { id: true },
      });
      ids.set(result.contestant, created.id);
    }
    return ids;
  });
}

function laneData(lane: Lane, examScore: number | null): Prisma.CuratorLaneCreateInput {
  return {
    slot: lane.slot,
    name: lane.name,
    description: lane.description,
    recipe: lane.recipe as unknown as Prisma.InputJsonValue,
    generation: lane.generation,
    parentName: lane.parentName,
    examScore,
    bornAt: lane.bornAt,
  };
}

/**
 * This run's evolution: score every learner seat the way the leaderboard does (live calls since
 * its lane took the seat, blended with its last exam), breed challengers from the strongest, and
 * hand runEvolvingContest the rule that picks the takeover. Null when evolution is off.
 */
async function evolutionPlan(
  env: Env,
  lanes: Lane[],
  targets: PrecisionTargets,
  now: Date,
): Promise<EvolutionPlan | null> {
  if (env.CURATOR_EVOLUTION_CHALLENGERS === 0 || lanes.length === 0) return null;
  const since = new Date(now.getTime() - FITNESS_WINDOW_DAYS * 86_400_000);
  const [live, active, top] = await Promise.all([
    liveCallRecords(
      lanes.map((l) => l.slot),
      since,
      lanes,
    ),
    prisma.curatorModel.findMany({
      where: { status: "active", contestant: { in: lanes.map((l) => l.slot) } },
      select: { contestant: true, evalMetrics: true },
    }),
    prisma.curatorLane.aggregate({ _max: { generation: true } }),
  ]);
  const lastExam = new Map(
    active.map((r) => [
      r.contestant!,
      (r.evalMetrics as Partial<StoredEvalMetrics> | null)?.exam ?? emptyRecord(),
    ]),
  );
  const fitness: LaneFitness[] = lanes.map((lane) => ({
    lane,
    // A seat whose lane is newer than its active model (it just took over) has no exam of its own
    // yet in storage - its live record alone, or nothing, judges it.
    composite: compositeScore(
      live.get(lane.slot) ?? emptyRecord(),
      lastExam.get(lane.slot) ?? emptyRecord(),
      targets,
    ).score,
  }));
  const seed = now.getTime() % 2_147_483_647;
  const challengers = breedChallengers(fitness, env.CURATOR_EVOLUTION_CHALLENGERS, seededRng(seed), {
    baseHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
    nextGeneration: (top._max.generation ?? 0) + 1,
  });
  if (challengers.length === 0) return null;
  return {
    challengers,
    decide: (laneExamScores, challengerScores) =>
      chooseReplacement({
        lanes: fitness.map((f) => ({ ...f, examScore: laneExamScores.get(f.lane.slot) ?? null })),
        challengerScores,
        now,
        minAgeMs: env.CURATOR_EVOLUTION_MIN_AGE_HOURS * 3_600_000,
        margin: env.CURATOR_EVOLUTION_MARGIN,
        challengerLearners: challengers.map((c) => c.recipe.learner),
      }),
  };
}

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
