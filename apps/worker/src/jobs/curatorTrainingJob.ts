import {
  refreshScoreWeights,
  prisma,
  createLogger,
  breedChallengers,
  recipeFamily,
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
  MODEL_WRITE_TX_OPTIONS,
  COMBINER_MODEL_KINDS,
  assessTrainingRun,
  lockCuratorModelWrites,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  walletSafetyCutsSql,
  maskKnownBadInputs,
  MAX_EVENT_AGE_MINUTES,
  Prisma,
  type ContestRunOutcome,
  type ContestantTrainingResult,
  type Lane,
  type LaneFitness,
  type StackedCuratorParams,
  type BlendCuratorParams,
  type AgreementCuratorParams,
  type Env,
  type TrainingRow,
  type PrecisionTargets,
  type StoredEvalMetrics,
  loadChampion,
  MIN_LIVE_CALLS_TO_RANK,
  RULES_CONTESTANT,
  RULES_MODEL_KIND,
  type DerivedRuleSet,
  type RulesCuratorParams,
  judgeProbation,
  type Challenger,
  type TrainedCuratorParams,
} from "@trenchscanner/core";
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
export async function runCuratorTrainingJob(
  env: Env,
): Promise<{ stored: boolean; heldBack?: string } | void> {
  const startedAt = Date.now();
  const windowStart = new Date(startedAt - env.CURATOR_TRAINING_WINDOW_DAYS * 86_400_000);
  // The Rules seat's exam replays the composite score with today's weights (scoreWeights.ts).
  await refreshScoreWeights();

  const trainingRows = await loadTrainingRows(windowStart, env.CURATOR_TRAINING_MAX_ROWS, LOAD_PAGE_ROWS, {
    min: env.MCAP_FILTER_MIN,
    max: env.MCAP_FILTER_MAX,
  });
  if (trainingRows.length < MIN_ROWS_TO_TRAIN) {
    logger.info("not enough finalized samples to train yet", {
      rows: trainingRows.length,
      needed: MIN_ROWS_TO_TRAIN,
    });
    return;
  }
  const budget = describeRowBudget(trainingRows, windowStart, env.CURATOR_TRAINING_MAX_ROWS);
  if (budget.capped) {
    // The window asked for more rows than the cap allows: the decision moments still reach back
    // the whole window, the hourly background does not (see loadTrainingRows).
    logger.info("training row cap reached - hourly background shortened to fit", budget);
  }
  // The history the models actually saw, not the window they were allowed: when the cap binds
  // the oldest row is days newer than windowStart, and the stored span should say so.
  const trainingFrom = trainingRows[trainingRows.length - 1]!.anchorAt;

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
  // The Narrative seat's own rows: every moment that carried the deep read (see
  // narrativeTrainingRows). Only loaded while the seat is on the roster.
  const narrativeRows = contestants.some((c) => c.role === "narrative")
    ? await narrativeTrainingRows(trainingRows, windowStart, env.CURATOR_TRAINING_MAX_ROWS)
    : [];

  // A takeover on probation is settled first: confirmed (its challenger takes the seat this
  // run), rejected or abandoned (breeding resumes), or still waiting (no breeding this run).
  const probation = await settleProbation(env, lanes, trainingRows, targets, now);
  const plan =
    probation.kind === "wait"
      ? null
      : await evolutionPlan(env, lanes, targets, now, probation.kind === "confirm" ? probation : undefined);
  // The Rules seat learns its checks from the best model (curation/rulesDistill.ts).
  const [rulesTeachers, currentRules] = env.CURATOR_RULES_FROM_BEST
    ? await Promise.all([rulesTeacherOrder(lanes, targets, now), loadCurrentRules()])
    : [[], null];
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
      runWeightPerDoubling: env.CURATOR_RUN_WEIGHT_PER_DOUBLING,
      minTestWins: env.CURATOR_EXAM_MIN_FOLD_WINS,
      highConvictionRank: env.CURATED_HIGH_CONVICTION_RANK,
      calibrationWindowDays: env.CURATOR_CALIBRATION_WINDOW_DAYS,
      featureOnsetGuard: env.CURATOR_FEATURE_ONSET_GUARD,
      rulesFromBest: env.CURATOR_RULES_FROM_BEST,
      rulesTeachers,
      currentRules,
      narrativeRows,
    },
    plan ?? undefined,
  );
  const { results } = outcome;
  // The Narrative seat sits out until it has rows enough (NARRATIVE_MIN_ROWS); its running
  // model, if any, stays active rather than retiring with the generation.
  const kept = contestants
    .filter((c) => c.role === "narrative" && !results.some((r) => r.contestant === c.id))
    .map((c) => c.id);
  if (results.length === 0) {
    logger.info("contest training produced nothing to store", { rows: trainingRows.length });
    return;
  }

  // The guard (curation/runGuard.ts): a plainly broken run - non-finite weights, a training set
  // that lost half its rows, every calling seat gone silent - keeps the running models instead.
  if (env.CURATOR_TRAINING_GUARD) {
    const verdict = assessTrainingRun({
      incumbents: await loadIncumbents(),
      results: results.map((r) => ({ contestant: r.contestant, kind: r.params.kind, params: r.params })),
      trainingRows: trainingRows.length,
      maxRows: env.CURATOR_TRAINING_MAX_ROWS,
      now: new Date(),
      maxHoldMs: env.CURATOR_GUARD_MAX_HOLD_HOURS * 3_600_000,
    });
    if (!verdict.accept) {
      logger.warn("training run held back - keeping the running models", {
        reason: verdict.reason,
        heldForHours: Math.round(verdict.heldSinceMs / 360_000) / 10,
        rows: trainingRows.length,
      });
      return { stored: false, heldBack: verdict.reason };
    }
    if (verdict.reason) logger.warn("training run let through by the guard", { reason: verdict.reason });
  }

  const modelIds = await applyContestResults(
    results,
    trainingRows.length,
    trainingFrom,
    { founding, replacement: outcome.replacement },
    { startedAt: new Date(startedAt), keep: kept },
  );
  if (modelIds === null) {
    logger.warn("models were replaced while this run trained (a restore) - its results were not stored");
    return { stored: false, heldBack: "models were replaced while this run trained" };
  }

  if (probation.kind === "confirm") {
    await resolveProbation(
      probation.id,
      outcome.replacement ? "confirmed" : "rejected",
      outcome.replacement
        ? probation.verdict
        : `passed probation but couldn't take the seat this run (${outcome.dropped ?? "no cutoff"}); ${probation.verdict}`,
    );
  }
  if (outcome.probation) {
    const p = outcome.probation;
    await prisma.curatorProbation.create({
      data: {
        slot: p.slot,
        name: p.bred.name,
        description: p.bred.description,
        recipe: p.bred.recipe as unknown as Prisma.InputJsonValue,
        generation: p.bred.generation,
        parentName: p.bred.parentName,
        examScore: p.examScore,
        reason: p.reason,
        challengerParams: p.challengerParams as unknown as Prisma.InputJsonValue,
        laneParams: p.laneParams as unknown as Prisma.InputJsonValue,
        laneName: p.laneName,
        startedAt: new Date(startedAt),
      },
    });
  }
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
      probation: outcome.probation
        ? {
            slot: outcome.probation.slot,
            name: outcome.probation.bred.name,
            reason: outcome.probation.reason,
            judgedAfterHours: env.CURATOR_EVOLUTION_PROBATION_HOURS,
          }
        : null,
      dropped: outcome.dropped,
    });
  }
  const rulesInUse = results.find((r) => r.contestant === RULES_CONTESTANT)?.metrics.rulesInUse;
  if (rulesInUse) {
    logger.info(rulesInUse.changed ? "rules seat changed its checks" : "rules seat kept its checks", {
      source: rulesInUse.source,
      teacher: rulesInUse.teacher?.name ?? null,
      agreementPct: rulesInUse.agreementPct ?? null,
      options: rulesInUse.options,
      reason: rulesInUse.reason,
      rules: rulesInUse.lines,
    });
  }
  // The new exams (and the live records since the last run) can change who leads: re-choose the
  // default model now, so users following the best performer switch with this run.
  await rechooseDefaultModel(env).catch((err: unknown) =>
    logger.warn("couldn't re-choose the default model", { error: String(err) }),
  );

  // The field-wide reports ride on every learner's metrics; the roster lists the combiners first.
  const learnerMetrics = results.find((r) => r.metrics.featureReport)?.metrics;
  logger.info("curator contest training complete", {
    durationMs: Date.now() - startedAt,
    rows: trainingRows.length,
    decisionRows: budget.eventRows,
    historyDays: budget.historyDays,
    // What the exam graded on: event rows alone, or with pseudo-events while those are too few.
    examPopulation: learnerMetrics?.examPopulation ?? null,
    contestants: results.map((r) => ({
      contestant: r.contestant,
      modelId: modelIds.get(r.contestant),
      threshold: "threshold" in r.params ? r.params.threshold : null,
      calibration: r.metrics.precisionCalibration,
      exam: r.metrics.exam,
      highConviction: r.metrics.highConviction ?? null,
      calibrationCalls: r.metrics.calibrationCalls ?? 0,
    })),
    // Inputs held back as too new (or lately dead) to train on - see curation/featureOnset.ts.
    heldFeatures: learnerMetrics?.heldFeatures?.map((h) => ({
      feature: h.feature,
      referencePct: h.referencePct,
      recentPct: h.recentPct,
    })),
    // The inputs' health this run: anything null on most rows, or with no lift at either end,
    // is a wire to check (see curation/featureReport.ts).
    featureReport: learnerMetrics?.featureReport
      ? {
          rows: learnerMetrics.featureReport.rows,
          mostlyNull: learnerMetrics.featureReport.features
            .filter((f) => f.nullRatePct >= 90)
            .map((f) => f.feature),
          strongest: [...learnerMetrics.featureReport.features]
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
  return { stored: true };
}

/** The models running now, as the guard sees them. */
async function loadIncumbents() {
  const rows = await prisma.curatorModel.findMany({
    where: { status: "active" },
    select: { contestant: true, kind: true, params: true, trainingRows: true, activatedAt: true },
  });
  return rows.map((r) => {
    const threshold = (r.params as { threshold?: unknown } | null)?.threshold;
    return {
      contestant: r.contestant,
      kind: r.kind,
      threshold: typeof threshold === "number" ? threshold : null,
      trainingRows: r.trainingRows,
      activatedAt: r.activatedAt,
    };
  });
}

/**
 * Re-chooses the default model (the leaderboard's best performer - curation/champion.ts) and logs
 * a change. Also run once at worker start when nothing has been chosen yet.
 */
export async function rechooseDefaultModel(
  env: Env,
): Promise<{ model: string; changed: boolean; liveGraded: number }> {
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
  return { model: champion.contestant, changed, liveGraded: champion.liveGraded };
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
  /**
   * When the run started. Models activated after it (a restore from the Admin tab, or another
   * run that got there first) win: this run's results are dropped and null is returned, rather
   * than overwriting a restore with models trained on the lanes it just replaced.
   */
  opts: {
    startedAt?: Date;
    /** Contestants whose active model stays as it is (a seat that sat this run out). */
    keep?: readonly string[];
  } = {},
): Promise<Map<string, string> | null> {
  const now = new Date();
  // The consensus and the blend reference their members, so they go after them.
  const dependent = (kind: string) => COMBINER_MODEL_KINDS.includes(kind);
  const ordered = [...results].sort(
    (a, b) => Number(dependent(a.params.kind)) - Number(dependent(b.params.kind)),
  );
  return prisma.$transaction(async (tx) => {
    // One writer of the active models at a time (see CURATOR_MODEL_WRITE_LOCK).
    await lockCuratorModelWrites(tx);
    if (opts.startedAt) {
      const newer = await tx.curatorModel.count({
        where: { status: "active", activatedAt: { gt: opts.startedAt } },
      });
      if (newer > 0) return null;
    }
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
      where: {
        status: { in: ["active", "candidate"] },
        ...(opts.keep && opts.keep.length > 0 ? { NOT: { contestant: { in: [...opts.keep] } } } : {}),
      },
      data: { status: "retired", retiredAt: now },
    });
    const ids = new Map<string, string>();
    for (const result of ordered) {
      let params = result.params;
      if (COMBINER_MODEL_KINDS.includes(params.kind)) {
        const withMembers = params as StackedCuratorParams | BlendCuratorParams | AgreementCuratorParams;
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
  }, MODEL_WRITE_TX_OPTIONS);
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

type ProbationState =
  | { kind: "none" }
  | { kind: "wait" }
  | { kind: "confirm"; id: string; slot: string; challenger: Challenger; reason: string; verdict: string };

/**
 * Settles the pending takeover probation, if any (curation/probation.ts). Once it has run
 * CURATOR_EVOLUTION_PROBATION_HOURS, the challenger and the seat - both frozen as they stood when
 * it was picked - are scored once on the decision moments that arrived since: a pass seats the
 * challenger this run, anything else retires the probation. Before then the run waits (no
 * breeding: one takeover is already in hand). A seat that changed hands meanwhile (a restore), or
 * probation turned off, abandons it.
 */
async function settleProbation(
  env: Env,
  lanes: Lane[],
  rows: TrainingRow[],
  targets: PrecisionTargets,
  now: Date,
): Promise<ProbationState> {
  const pending = await prisma.curatorProbation.findFirst({
    where: { resolvedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (!pending) return { kind: "none" };
  const lane = lanes.find((l) => l.slot === pending.slot);
  if (env.CURATOR_EVOLUTION_PROBATION_HOURS === 0) {
    await resolveProbation(pending.id, "abandoned", "probation was turned off");
    return { kind: "none" };
  }
  if (!lane || lane.bornAt > pending.startedAt) {
    await resolveProbation(pending.id, "abandoned", "the seat changed hands while it waited");
    return { kind: "none" };
  }
  const waitedHours = (now.getTime() - pending.startedAt.getTime()) / 3_600_000;
  if (waitedHours < env.CURATOR_EVOLUTION_PROBATION_HOURS) {
    logger.info("takeover on probation - waiting for fresh calls", {
      slot: pending.slot,
      challenger: pending.name,
      waitedHours: Math.round(waitedHours * 10) / 10,
      judgedAfterHours: env.CURATOR_EVOLUTION_PROBATION_HOURS,
    });
    return { kind: "wait" };
  }
  const verdict = judgeProbation({
    rows,
    startedAt: pending.startedAt,
    challenger: pending.challengerParams as unknown as TrainedCuratorParams,
    lane: pending.laneParams as unknown as TrainedCuratorParams,
    mcapBand: { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX },
    cooldownMs: env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000,
    targets,
    minWins: env.CURATOR_EVOLUTION_PROBATION_MIN_WINS,
    confidence: env.CURATOR_EVOLUTION_CONFIDENCE,
    rng: seededRng(pending.startedAt.getTime() % 2_147_483_647),
  });
  logger.info(verdict.confirm ? "takeover probation passed" : "takeover probation failed", {
    slot: pending.slot,
    challenger: pending.name,
    seat: pending.laneName,
    reason: verdict.reason,
  });
  if (!verdict.confirm) {
    await resolveProbation(pending.id, "rejected", verdict.reason);
    return { kind: "none" };
  }
  return {
    kind: "confirm",
    id: pending.id,
    slot: pending.slot,
    challenger: {
      recipe: pending.recipe as unknown as Challenger["recipe"],
      name: pending.name,
      description: pending.description,
      generation: pending.generation,
      parentName: pending.parentName ?? "",
    },
    reason: `${pending.reason}; then on probation, ${verdict.reason}`,
    verdict: verdict.reason,
  };
}

async function resolveProbation(
  id: string,
  outcome: "confirmed" | "rejected" | "abandoned",
  reason: string,
): Promise<void> {
  await prisma.curatorProbation.update({
    where: { id },
    data: { resolvedAt: new Date(), outcome, resolvedReason: reason },
  });
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
  confirm?: Extract<ProbationState, { kind: "confirm" }>,
): Promise<ContestPlan | null> {
  if (lanes.length === 0) return null;
  if (!confirm && env.CURATOR_EVOLUTION_CHALLENGERS === 0) return null;
  const [fitness, top, topProbation, lastTakeover] = await Promise.all([
    laneFitness(lanes, targets, now),
    prisma.curatorLane.aggregate({ _max: { generation: true } }),
    prisma.curatorProbation.aggregate({ _max: { generation: true } }),
    prisma.curatorLane.aggregate({ _max: { bornAt: true }, where: { generation: { gt: 0 } } }),
  ]);
  const seed = now.getTime() % 2_147_483_647;
  // A confirmed probation's challenger is the run's only one: it sits the exam to train the
  // model it will ship with, and takes the seat (ContestPlan.confirm).
  const challengers = confirm
    ? [confirm.challenger]
    : breedChallengers(fitness, env.CURATOR_EVOLUTION_CHALLENGERS, seededRng(seed), {
        baseHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
        nextGeneration: Math.max(top._max.generation ?? 0, topProbation._max.generation ?? 0) + 1,
      });
  if (challengers.length === 0) return null;
  return {
    challengers,
    ...(confirm
      ? { confirm: { slot: confirm.slot, reason: confirm.reason } }
      : env.CURATOR_EVOLUTION_PROBATION_HOURS > 0
        ? { probation: true }
        : {}),
    rule: {
      lanes: fitness,
      now,
      minAgeMs: env.CURATOR_EVOLUTION_MIN_AGE_HOURS * 3_600_000,
      margin: env.CURATOR_EVOLUTION_MARGIN,
      challengerLearners: challengers.map((c) => recipeFamily(c.recipe)),
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

/**
 * Every learner seat scored the way the leaderboard does: live calls since its lane took the
 * seat, blended with its last exam.
 */
async function laneFitness(lanes: Lane[], targets: PrecisionTargets, now: Date): Promise<LaneFitness[]> {
  const since = new Date(now.getTime() - FITNESS_WINDOW_DAYS * 86_400_000);
  const [live, active] = await Promise.all([
    liveCallRecords(
      lanes.map((l) => l.slot),
      since,
      lanes,
    ),
    prisma.curatorModel.findMany({
      where: { status: "active", contestant: { in: lanes.map((l) => l.slot) } },
      select: { contestant: true, evalMetrics: true },
    }),
  ]);
  const lastExam = new Map(
    active.map((r) => [
      r.contestant!,
      (r.evalMetrics as Partial<StoredEvalMetrics> | null)?.exam ?? emptyRecord(),
    ]),
  );
  return lanes.map((lane) => ({
    lane,
    // A seat whose lane is newer than its active model (it just took over) has no exam of its own
    // yet in storage - its live record alone, or nothing, judges it.
    composite: compositeScore(
      live.get(lane.slot) ?? emptyRecord(),
      lastExam.get(lane.slot) ?? emptyRecord(),
      targets,
    ).score,
    // Seats still warming up breed last, as the leaderboard ranks them (see LaneFitness).
    liveGraded: live.get(lane.slot)?.graded ?? 0,
  }));
}

/**
 * Who the Rules seat learns its checks from this run, best first: the default model when it is a
 * learner seat, then the learner seats in leaderboard order (seasoned seats first, then by score).
 * runEvolvingContest takes the first one it examined.
 */
async function rulesTeacherOrder(lanes: Lane[], targets: PrecisionTargets, now: Date): Promise<string[]> {
  const [fitness, champion] = await Promise.all([laneFitness(lanes, targets, now), loadChampion()]);
  const ranked = [...fitness]
    .sort(
      (a, b) =>
        Number((b.liveGraded ?? 0) >= MIN_LIVE_CALLS_TO_RANK) -
          Number((a.liveGraded ?? 0) >= MIN_LIVE_CALLS_TO_RANK) || (b.composite ?? -1) - (a.composite ?? -1),
    )
    .map((f) => f.lane.slot);
  const first = champion && ranked.includes(champion.contestant) ? [champion.contestant] : [];
  return [...first, ...ranked.filter((slot) => !first.includes(slot))];
}

/** The learned rules the Rules seat runs now, if any (RulesCuratorParams.derived). */
async function loadCurrentRules(): Promise<DerivedRuleSet | null> {
  const row = await prisma.curatorModel.findFirst({
    where: { status: "active", contestant: RULES_CONTESTANT, kind: RULES_MODEL_KIND },
    orderBy: { createdAt: "desc" },
    select: { params: true },
  });
  return (row?.params as Partial<RulesCuratorParams> | null)?.derived ?? null;
}

/** Rows fetched per query - keeps the driver's raw result for any one page small. */
const LOAD_PAGE_ROWS = 5_000;

/**
 * The training set for one run: every finalized decision moment ("event" row) in the window, plus
 * as much of the hourly background as the row cap leaves room for, newest first.
 *
 * The cap exists for memory (CURATOR_TRAINING_MAX_ROWS); the window is the horizon the models
 * are meant to learn from. Taken newest-first across both kinds, the cap would also be the
 * horizon as soon as the scan banked more rows than it holds - on 2026-10-04 that was about
 * eight days of a 21-day window, shrinking as discovery widened - and the exam's graded history
 * (decision moments) would stop growing with the data. Event rows are a small share of the rows
 * (about one in fourteen), so keeping all of them costs little; what the cap trims is background
 * samples of tokens the feed never decides on, where more depth is worth the least. Emission and
 * match rows stay out: they exist because a curator or a user's filter picked them, and training
 * on them would teach someone's selection rather than the market (see CandidateOutcome.sampleKind).
 */
export async function loadTrainingRows(
  windowStart: Date,
  maxRows: number,
  pageRows = LOAD_PAGE_ROWS,
  band?: { min: number; max: number },
): Promise<TrainingRow[]> {
  const events = await loadRowsOfKind("event", windowStart, maxRows, pageRows);
  const hourly = withoutEventTwins(
    await loadRowsOfKind("hourly", windowStart, maxRows - events.length, pageRows, band),
    events,
  );
  // Newest first, as a single newest-first query would have returned them; ties keep events first.
  return [...events, ...hourly].sort((a, b) => b.anchorAt.getTime() - a.anchorAt.getTime());
}

/** An hourly row this close to one of its token's event rows was banked from the same scan. */
const TWIN_WINDOW_MS = 5_000;

/**
 * The scan banks a token's hourly row and its event row from the same scored token when both are
 * due in one cycle, so the moment would sit in the training set twice (a fifth of event rows had
 * such a twin, 2026-10-08). The event row is the one the exam reads; its hourly twin goes.
 */
export function withoutEventTwins<T extends { tokenId?: string; anchorAt: Date }>(
  hourly: readonly T[],
  events: readonly { tokenId?: string; anchorAt: Date }[],
): T[] {
  const eventTimes = new Map<string, number[]>();
  for (const e of events) {
    // A row with no token can't be matched to anything, so it is never anyone's twin.
    if (e.tokenId === undefined) continue;
    const list = eventTimes.get(e.tokenId) ?? [];
    list.push(e.anchorAt.getTime());
    eventTimes.set(e.tokenId, list);
  }
  return hourly.filter((h) => {
    const times = h.tokenId === undefined ? undefined : eventTimes.get(h.tokenId);
    const t = h.anchorAt.getTime();
    return !times?.some((e) => Math.abs(e - t) < TWIN_WINDOW_MS);
  });
}

/**
 * The Narrative seat's training set (curation/contestants.ts): the run's decision moments and
 * hourly background that carried the deep read (nsDepthFull = 1), plus the second looks the scan
 * took when a deep read landed after a token's last decision - those count as decision moments
 * for this seat alone, so they are relabeled "event" here and nowhere else. Newest first, capped
 * like the main set.
 */
export async function narrativeTrainingRows(
  trainingRows: readonly TrainingRow[],
  windowStart: Date,
  maxRows: number,
  pageRows = LOAD_PAGE_ROWS,
): Promise<TrainingRow[]> {
  const withRead = trainingRows.filter((r) => r.features.nsDepthFull === 1);
  const seconds = (
    await loadRowsOfKind("second", windowStart, Math.max(0, maxRows - withRead.length), pageRows)
  )
    .filter((r) => r.features.nsDepthFull === 1)
    .map((r) => ({ ...r, sampleKind: "event" }));
  return [...seconds, ...withRead].sort((a, b) => b.anchorAt.getTime() - a.anchorAt.getTime());
}

/** What loadTrainingRows kept, for the run's log: how deep each kind reaches and whether the cap bound. */
export function describeRowBudget(
  rows: readonly TrainingRow[],
  windowStart: Date,
  maxRows: number,
): {
  rows: number;
  eventRows: number;
  hourlyRows: number;
  capped: boolean;
  /** Days between the oldest row kept and the newest. */
  historyDays: number;
  /** Days of hourly background kept, counted from the newest row. */
  hourlyDays: number;
  windowDays: number;
} {
  const newest = rows.reduce((m, r) => Math.max(m, r.anchorAt.getTime()), Number.NEGATIVE_INFINITY);
  const oldestOf = (kind?: string) =>
    rows.reduce(
      (m, r) => (kind === undefined || r.sampleKind === kind ? Math.min(m, r.anchorAt.getTime()) : m),
      Number.POSITIVE_INFINITY,
    );
  const days = (oldest: number) =>
    Number.isFinite(oldest) && Number.isFinite(newest)
      ? Math.round(((newest - oldest) / 86_400_000) * 10) / 10
      : 0;
  const eventRows = rows.filter((r) => r.sampleKind === "event").length;
  return {
    rows: rows.length,
    eventRows,
    hourlyRows: rows.length - eventRows,
    capped: rows.length >= maxRows,
    historyDays: days(oldestOf()),
    hourlyDays: days(oldestOf("hourly")),
    windowDays: Number.isFinite(newest)
      ? Math.round(((newest - windowStart.getTime()) / 86_400_000) * 10) / 10
      : 0,
  };
}

/**
 * The newest `maxRows` finalized rows of one sample kind in the window, newest first. Paged, so
 * the query engine's raw result is never the whole window at once - only the mapped rows
 * accumulate.
 */
/**
 * TrainingRow.runPeakMultiple for a stored row: the label window's peak (peak1hReturnPct - the
 * 30-minute watch every row has), as a multiple of the alert price.
 *
 * Not the 24h run peak, on purpose (user decision 2026-10-07). Only rows a champion alerted live
 * get the extended watch (CandidateOutcome.extendedWatch), so a 24h peak here depended on whether
 * an EARLIER champion called the token, not on the token - and every contestant's exam run size
 * (runDoublings, 10 points of the score) leaned toward recipes that agree with the incumbent. The
 * window peak is measured the same way for every decision row, so the exam grades contestants on
 * the same evidence; the live record keeps the 24h peak (RUN_DOUBLINGS in laneStore.ts), where
 * every call was watched for it. The 10x tier (hit10x below) was never affected: its hour is on
 * the extended watch every clean winner gets, alerted or not. The fit's run weight (runWeight)
 * and the runner-traits report read this field too, so they see the window peak now as well.
 */
function runPeakOf(r: { peak1hReturnPct: number | null }): { runPeakMultiple?: number } {
  return r.peak1hReturnPct !== null ? { runPeakMultiple: 1 + r.peak1hReturnPct / 100 } : {};
}

/**
 * Hard stop on pages per kind: the keyset loop below ends when the window runs dry or the cap
 * is met, and this bounds it against a window that is mostly screen-rejected rows.
 */
const LOAD_MAX_PAGES = 200;

interface LoadedRow {
  id: string;
  tokenId: string;
  anchorAt: Date;
  features: unknown;
  labelValue: number | null;
  anchorPriceUsd: number;
  signalPriceUsd: number | null;
  anchorMcapUsd: number;
  sampleKind: string;
  labelRule: number;
  maxDrawdown1hPct: number | null;
  peak1hReturnPct: number | null;
  hit10xIn1h: boolean | null;
}

async function loadRowsOfKind(
  sampleKind: "hourly" | "event" | "second",
  windowStart: Date,
  maxRows: number,
  pageRows: number,
  band?: { min: number; max: number },
): Promise<TrainingRow[]> {
  // Background rows are banked across the padded scan band, but no call is ever made outside the
  // curated band: half of them sat under its floor (2026-10-08), teaching a market nobody trades.
  const bandSql =
    band !== undefined ? Prisma.sql`AND "anchorMcapUsd" BETWEEN ${band.min} AND ${band.max}` : Prisma.empty;
  // Decision moments older than the event pre-gate's age cap were banked before the cap existed
  // (2026-10-05): a live decision can no longer be one, so they neither train nor grade.
  const ageSql =
    sampleKind === "event"
      ? Prisma.sql`AND COALESCE(("features"::jsonb ->> 'ageMinutes')::float8, 0) <= ${MAX_EVENT_AGE_MINUTES}`
      : Prisma.empty;
  const out: TrainingRow[] = [];
  let cursor: { anchorAt: Date; id: string } | undefined;
  let pages = 0;
  while (out.length < maxRows && pages < LOAD_MAX_PAGES) {
    pages += 1;
    const take = Math.min(pageRows, maxRows - out.length);
    // A token the safety screen rejects today never reaches a curator, so a row banked before
    // the cut was tightened (mostly farm launches that pump, then rug) neither trains nor grades.
    // The cut is in the query (walletSafetyCutsSql - the same condition the reports count by),
    // not applied to the page afterwards: filtered client-side, each page came back short of
    // `take` by however many it dropped, and a window of mostly rejected rows cost its pages
    // in full for a few rows kept. Keyset-paged on (anchorAt, id), newest first.
    const page = await prisma.$queryRaw<LoadedRow[]>`
      SELECT "id", "tokenId", "anchorAt", "features", "labelValue", "anchorPriceUsd",
             "signalPriceUsd", "anchorMcapUsd", "sampleKind", "labelRule", "maxDrawdown1hPct",
             "peak1hReturnPct", "hit10xIn1h"
      FROM "CandidateOutcome"
      WHERE "finalizedAt" IS NOT NULL
        AND "anchorAt" >= ${windowStart}
        AND "sampleKind" = ${sampleKind}
        AND ${walletSafetyCutsSql()}
        ${bandSql}
        ${ageSql}
        ${cursor !== undefined ? Prisma.sql`AND ("anchorAt", "id") < (${cursor.anchorAt}, ${cursor.id})` : Prisma.empty}
      ORDER BY "anchorAt" DESC, "id" DESC
      LIMIT ${take}`;
    for (const r of page) {
      // Inputs known to be wrong on old rows (fake order-flow zeros) read as missing.
      const features = maskKnownBadInputs(r.anchorAt, r.features as Record<string, number | null>);
      out.push({
        tokenId: r.tokenId,
        anchorAt: r.anchorAt,
        features,
        labelValue: r.labelValue ?? 0,
        // The price the features were observed at (the alert price the label is graded from).
        anchorPriceUsd: r.signalPriceUsd ?? r.anchorPriceUsd,
        anchorMcapUsd: r.anchorMcapUsd,
        sampleKind: r.sampleKind,
        labelRule: r.labelRule,
        // Held above the stop through the label window (the two-stage model's first-stage
        // label). Unknown when the drawdown was never recorded.
        ...(r.maxDrawdown1hPct !== null
          ? { survived: r.maxDrawdown1hPct > -DISQUALIFYING_DRAWDOWN_FRACTION * 100 }
          : {}),
        // The label window's peak, for the exam's run size (runDoublings credits a clean winner
        // and a late runner that held above the stop), the fit's run weight and the runner-traits
        // report - see runPeakOf for why not the 24h peak.
        ...runPeakOf(r),
        // The 10x tier, for the exam's 10x part of the score; unknown until the row's hour settles.
        ...(r.hit10xIn1h !== null ? { hit10x: r.hit10xIn1h } : {}),
      });
    }
    if (page.length < take) break;
    const last = page[page.length - 1]!;
    cursor = { anchorAt: last.anchorAt, id: last.id };
  }
  // The count that is true after the screen's cut, which is the set that trains.
  logger.info("loaded training rows", { sampleKind, rows: out.length, pages, capped: out.length >= maxRows });
  return out;
}
