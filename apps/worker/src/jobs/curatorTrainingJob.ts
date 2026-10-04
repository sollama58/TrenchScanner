import {
  prisma,
  createLogger,
  breedChallengers,
  compositeScore,
  emptyRecord,
  enabledContestants,
  foundingLanes,
  liveCallRecords,
  loadCurrentLanes,
  rechooseChampion,
  seededRng,
  withLanes,
  NEVER_EMIT_THRESHOLD,
  STACKED_MODEL_KIND,
  BLEND_MODEL_KIND,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  type ContestRunOutcome,
  type ContestantTrainingResult,
  type Lane,
  type LaneFitness,
  type StackedCuratorParams,
  type BlendCuratorParams,
  type Env,
  type TrainingRow,
  type PrecisionTargets,
  type StoredEvalMetrics,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";
import { runContestOffThread } from "../training/runContest.js";
import type { ContestPlan } from "../training/contestPlan.js";

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
  // Founding lanes breed from the roster's current recipe, not the copy stored when they were
  // seated (see withLanes).
  const lanes = [...stored, ...founding].flatMap((l) => {
    const spec = roster.find((s) => s.id === l.slot);
    if (!spec) return [];
    return [l.generation === 0 && spec.recipe ? { ...l, recipe: spec.recipe } : l];
  });
  const contestants = withLanes(roster, lanes);

  const plan = await evolutionPlan(env, lanes, targets, now);
  // Every learner contestant sits the same walk-forward exam and ships its own model at its own
  // cutoff; challengers sit it too; the consensus is stacked on the final lineup's out-of-sample
  // calls (see runEvolvingContest in packages/core/src/curation/trainingRun.ts for all the math).
  const outcome = await runContestOffThread(
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
      legacyLabelWeight: env.CURATOR_LEGACY_LABEL_WEIGHT,
      minTestWins: env.CURATOR_EXAM_MIN_FOLD_WINS,
      highConvictionRank: env.CURATED_HIGH_CONVICTION_RANK,
      calibrationWindowDays: env.CURATOR_CALIBRATION_WINDOW_DAYS,
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
  // The new exams (and the live records since the last run) can change who leads: re-choose the
  // default model now, so users following the best performer switch with this run.
  await rechooseDefaultModel(env).catch((err: unknown) =>
    logger.warn("couldn't re-choose the default model", { error: String(err) }),
  );

  logger.info("curator contest training complete", {
    durationMs: Date.now() - startedAt,
    rows: trainingRows.length,
    contestants: results.map((r) => ({
      contestant: r.contestant,
      modelId: modelIds.get(r.contestant),
      threshold: "threshold" in r.params ? r.params.threshold : null,
      calibration: r.metrics.precisionCalibration,
      exam: r.metrics.exam,
      highConviction: r.metrics.highConviction ?? null,
      calibrationCalls: r.metrics.calibrationCalls ?? 0,
    })),
    // The inputs' health this run: anything null on most rows, or with no lift at either end,
    // is a wire to check (see curation/featureReport.ts).
    featureReport: results[0]?.metrics.featureReport
      ? {
          rows: results[0].metrics.featureReport.rows,
          mostlyNull: results[0].metrics.featureReport.features
            .filter((f) => f.nullRatePct >= 90)
            .map((f) => f.feature),
          strongest: [...results[0].metrics.featureReport.features]
            .filter((f) => f.topDecileLift !== null)
            .sort(
              (a, b) =>
                Math.max(b.topDecileLift!, b.bottomDecileLift!) -
                Math.max(a.topDecileLift!, a.bottomDecileLift!),
            )
            .slice(0, 8)
            .map((f) => ({ feature: f.feature, top: f.topDecileLift, bottom: f.bottomDecileLift })),
        }
      : null,
  });
}

/**
 * Re-chooses the default model (the leaderboard's best performer - curation/champion.ts) and logs
 * a change. Also run once at worker start when nothing has been chosen yet.
 */
export async function rechooseDefaultModel(env: Env): Promise<void> {
  const lanes = await loadCurrentLanes();
  const { champion, changed, pick } = await rechooseChampion({
    roster: withLanes(enabledContestants(env.CURATOR_CONTESTANTS), lanes),
    lanes,
    targets: {
      winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
      goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
      minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
      confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
    },
    rules: { minLiveGraded: env.CURATOR_CHAMPION_MIN_LIVE_GRADED, margin: env.CURATOR_CHAMPION_MARGIN },
  });
  logger.info(changed ? "default model re-chosen" : "default model unchanged", {
    model: champion.contestant,
    score: champion.score,
    liveGraded: champion.liveGraded,
    reason: pick.reason,
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
  // The consensus and the blend reference their members, so they go after them.
  const dependent = (kind: string) => kind === STACKED_MODEL_KIND || kind === BLEND_MODEL_KIND;
  const ordered = [...results].sort(
    (a, b) => Number(dependent(a.params.kind)) - Number(dependent(b.params.kind)),
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
      if (params.kind === STACKED_MODEL_KIND || params.kind === BLEND_MODEL_KIND) {
        const withMembers = params as StackedCuratorParams | BlendCuratorParams;
        params = {
          ...withMembers,
          members: withMembers.members.map((m) => ({ ...m, modelId: ids.get(m.contestant) ?? "" })),
        } as typeof params;
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
 * hand runEvolvingContest the inputs to the rule that picks the takeover (see ContestPlan). Null when evolution is off.
 */
async function evolutionPlan(
  env: Env,
  lanes: Lane[],
  targets: PrecisionTargets,
  now: Date,
): Promise<ContestPlan | null> {
  if (env.CURATOR_EVOLUTION_CHALLENGERS === 0 || lanes.length === 0) return null;
  const since = new Date(now.getTime() - FITNESS_WINDOW_DAYS * 86_400_000);
  const [live, active, top, lastTakeover] = await Promise.all([
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
    prisma.curatorLane.aggregate({ _max: { bornAt: true }, where: { generation: { gt: 0 } } }),
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
    rule: {
      lanes: fitness,
      now,
      minAgeMs: env.CURATOR_EVOLUTION_MIN_AGE_HOURS * 3_600_000,
      margin: env.CURATOR_EVOLUTION_MARGIN,
      challengerLearners: challengers.map((c) => c.recipe.learner),
      evidence: {
        minExamWins: env.CURATOR_EVOLUTION_MIN_EXAM_WINS,
        confidence: env.CURATOR_EVOLUTION_CONFIDENCE,
        lastTakeoverAt: lastTakeover._max.bornAt ?? null,
        minTakeoverIntervalMs: env.CURATOR_EVOLUTION_MIN_TAKEOVER_INTERVAL_HOURS * 3_600_000,
        targets,
        seed,
      },
    },
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
        labelRule: true,
        maxDrawdown1hPct: true,
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
        labelRule: r.labelRule,
        // Held above the stop for the hour (the two-stage model's first-stage label). Unknown
        // when the drawdown was never recorded.
        ...(r.maxDrawdown1hPct !== null
          ? { survived: r.maxDrawdown1hPct > -DISQUALIFYING_DRAWDOWN_FRACTION * 100 }
          : {}),
      });
    }
    if (page.length < pageRows) break;
    cursor = page[page.length - 1]!.id;
  }
  return out;
}
