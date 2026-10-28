import {
  refreshScoreWeights,
  curatedTargets,
  simulateExitPlan,
  exitPlanPositionOpen,
  EXIT_PLAN,
  prisma,
  createLogger,
  breedChallengers,
  recipeFamily,
  compositeScore,
  withLiveCatch,
  emptyRecord,
  enabledContestants,
  foundingLanes,
  liveCallRecords,
  liveCatchRates,
  loadCurrentLanes,
  rechooseChampion,
  seededRng,
  withLanes,
  NEVER_EMIT_THRESHOLD,
  MODEL_WRITE_TX_OPTIONS,
  COMBINER_MODEL_KINDS,
  assessTrainingRun,
  examRegressionAlarms,
  fillRateAlarms,
  findZeroEras,
  zeroEraAlarms,
  inputFills,
  liveShareAlarms,
  LEARNER_FEATURE_NAMES,
  RETIRED_LEARNER_INPUTS,
  lockCuratorModelWrites,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  passesWalletSafetyCuts,
  maskKnownBadInputs,
  maskTokenSageXReuseLoss,
  HOLDER_TRANSFER_LINKED_FEATURES,
  applyClockFeatures,
  isPreFeeWalletStonksRow,
  withLaunchAge,
  withoutPreCanonicalPairAge,
  AGE_FROM_LAUNCH_SINCE,
  TRAINING_ROW_RULES_SINCE,
  trainingWeightByAge,
  MAX_EVENT_AGE_MINUTES,
  FRESH_ANCHOR_LABEL_RULE,
  trainsOnLabelRule,
  isDecisionRow,
  CANDIDATE_FEATURE_NAMES,
  ALL_NARRATIVE_FEATURES,
  Prisma,
  type ContestRunOutcome,
  type ContestantTrainingResult,
  type Lane,
  type LaneFitness,
  type StackedCuratorParams,
  type BlendCuratorParams,
  type AgreementCuratorParams,
  type TopSliceCuratorParams,
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
  type UnthresholdedCuratorParams,
  gatesById,
  loadModelGates,
  GEMERALD_ASKED_AT,
  GEMERALD_GATE,
  hasOwnPopulation,
} from "@trenchscanner/core";
import { RunProgress } from "../runProgress.js";
import { runContestOffThread } from "../training/runContest.js";
import type { ContestPlan } from "../training/contestPlan.js";

const logger = createLogger("curator-training");

/**
 * The serving champion's scoring params, for the held-out-day comparison. A Rules champion has
 * no scored model. Only called when CURATOR_CHAMPION_HOLDOUT_GATE is on.
 */
async function loadServingChampionParams(): Promise<UnthresholdedCuratorParams | null> {
  const champ = await loadChampion();
  if (!champ || champ.contestant === RULES_CONTESTANT) return null;
  const row = await prisma.curatorModel.findFirst({
    where: { contestant: champ.contestant, status: "active" },
    orderBy: { createdAt: "desc" },
    select: { kind: true, params: true },
  });
  if (!row || row.kind === RULES_MODEL_KIND) return null;
  if (typeof row.params !== "object" || row.params === null || Array.isArray(row.params)) return null;
  return row.params as unknown as UnthresholdedCuratorParams;
}

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
): Promise<{ stored?: boolean; heldBack?: string; alarms?: string; stagesMs: Record<string, number> }> {
  // Each stage is written to the heartbeat as the run reaches it, so the admin panel can say where
  // a run has got to - and where a stuck one stopped (runProgress.ts).
  const progress = new RunProgress("curator-training");
  try {
    const result = await trainCurators(env, progress);
    return { ...result, stagesMs: progress.finish() };
  } catch (err) {
    progress.finish();
    throw err;
  }
}

async function trainCurators(
  env: Env,
  progress: RunProgress,
): Promise<{ stored: boolean; heldBack?: string; alarms?: string } | void> {
  const startedAt = Date.now();
  const windowStart = new Date(startedAt - env.CURATOR_TRAINING_WINDOW_DAYS * 86_400_000);
  // The Rules seat's exam replays the composite score with today's weights (scoreWeights.ts).
  progress.stage("score weights");
  await refreshScoreWeights();

  progress.stage("load rows");

  const trainingRows = await loadTrainingRows(
    windowStart,
    env.CURATOR_TRAINING_MAX_ROWS,
    LOAD_PAGE_ROWS,
    {
      min: env.MCAP_FILTER_MIN,
      max: env.MCAP_FILTER_MAX,
    },
    {
      excludeFineTickLabels: env.CURATOR_EXCLUDE_FINE_TICK_LABELS,
      tokenSageXReuseRestoredAt: env.TOKENSAGE_XREUSE_RESTORED_AT,
      trainOnEntryRows: env.CURATOR_TRAIN_ON_ENTRY_ROWS,
    },
  );
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
  // How far the default half-life tilts this run toward the present, on the rows in hand: the
  // same figure every learner seat stores under its own half-life (evalMetrics.trainingWeightByAge).
  logger.info("training weight by age", {
    ...budget,
    ...trainingWeightByAge(trainingRows, {
      recencyHalfLifeDays: env.CURATOR_RECENCY_HALF_LIFE_DAYS,
      legacyLabelWeight: env.CURATOR_LEGACY_LABEL_WEIGHT,
      runWeightPerDoubling: env.CURATOR_RUN_WEIGHT_PER_DOUBLING,
    }),
  });

  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    minSupportShare: env.CURATED_MIN_CALIBRATION_SHARE,
    coverageTolerance: env.CURATED_CUTOFF_COVERAGE_TOLERANCE,
    targetShare: env.CURATED_CUTOFF_TARGET_SHARE,
    shareBand: env.CURATED_CUTOFF_SHARE_BAND,
    shareHurdle: env.CURATED_CUTOFF_SHARE_HURDLE,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  // The field as it stands: each learner seat trains its current lane's recipe. Seats that have
  // never had a lane stored (first run after the evolution deploy) start from their founding
  // recipe, stored with this run.
  const now = new Date(startedAt);
  progress.stage("plan");
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
  // The Narrative seat's second looks (see narrativeTrainingRows). Only loaded while the seat is
  // on the roster.
  const narrativeRows = contestants.some((c) => c.role === "narrative")
    ? await narrativeTrainingRows(windowStart, env.CURATOR_TRAINING_MAX_ROWS, LOAD_PAGE_ROWS, {
        tokenSageXReuseRestoredAt: env.TOKENSAGE_XREUSE_RESTORED_AT,
      })
    : [];
  // The gated seats' frozen filters (Gems, curation/modelGate.ts). Only read while one is on the roster.
  const storedGates = contestants.some((c) => c.gate !== undefined) ? await loadModelGates() : [];
  const gates = gatesById(storedGates);
  for (const c of contestants) {
    if (c.gate !== undefined && !(c.gate in gates)) {
      logger.warn("gated seat has no stored gate - it sits out and calls nothing", {
        contestant: c.id,
        gate: c.gate,
      });
    }
  }
  // The copy was asked for as Gemerald stood then; one taken after a later edit says so.
  const gemerald = storedGates.find((g) => g.id === GEMERALD_GATE);
  if (gemerald?.sourceCriteriaChangedAt && gemerald.sourceCriteriaChangedAt > GEMERALD_ASKED_AT) {
    logger.warn("Gems' gate copied Gemerald after an edit made since it was asked for", {
      editedAt: gemerald.sourceCriteriaChangedAt.toISOString(),
      askedAt: GEMERALD_ASKED_AT.toISOString(),
    });
  }

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
  progress.stage("exams");
  const servingChampionParams = env.CURATOR_CHAMPION_HOLDOUT_GATE ? await loadServingChampionParams() : null;
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
      examShare: env.CURATOR_EXAM_SHARE,
      highConvictionRank: env.CURATED_HIGH_CONVICTION_RANK,
      calibrationWindowDays: env.CURATOR_CALIBRATION_WINDOW_DAYS,
      featureOnsetGuard: env.CURATOR_FEATURE_ONSET_GUARD,
      unknownRiskFails: env.SAFETY_UNKNOWN_RISK_FAILS,
      championHoldoutGate: env.CURATOR_CHAMPION_HOLDOUT_GATE,
      servingChampionParams,
      windowStart,
      rulesFromBest: env.CURATOR_RULES_FROM_BEST,
      rulesTeachers,
      currentRules,
      narrativeRows,
      gates,
    },
    plan ?? undefined,
    (step, done, total) => progress.step(`${step} (${done + 1} of up to ${total})`),
  );
  const { results } = outcome;
  // The Narrative seat sits out until it has rows enough (NARRATIVE_MIN_ROWS), a gated seat until its
  // gate is stored and lets enough through (GATED_MIN_ROWS), Winners until enough rows carry its
  // reading (the same floor), and the 10× Hunter until enough rows have a known 10× verdict
  // (outcome.skipped). A running model, if any, stays active rather than retiring with the generation.
  const kept = [
    ...contestants
      .filter(
        (c) => (c.role === "narrative" || hasOwnPopulation(c)) && !results.some((r) => r.contestant === c.id),
      )
      .map((c) => c.id),
    ...outcome.skipped.map((s) => s.contestant),
  ];
  if (results.length === 0) {
    logger.info("contest training produced nothing to store", {
      rows: trainingRows.length,
      skipped: outcome.skipped,
    });
    return;
  }

  // Alarms only (runGuard.ts): an exam that fell sharply against the model it replaces, and an
  // input the learners read gone dead (or a retired one filled again). Nothing waits on them.
  const incumbentExams = await loadIncumbentExams();
  const alarms = [
    ...examRegressionAlarms(
      incumbentExams,
      results.flatMap((r) =>
        r.metrics.exam
          ? [{ contestant: r.contestant, wins: r.metrics.exam.wins, graded: r.metrics.exam.graded }]
          : [],
      ),
    ),
    ...fillRateAlarms(
      inputFills(trainingRows, CANDIDATE_FEATURE_NAMES, env.CURATOR_EXAM_SHARE, windowStart),
      new Set<string>(LEARNER_FEATURE_NAMES),
      RETIRED_LEARNER_INPUTS as ReadonlySet<string>,
    ),
    // A learner input that read 0 far more (or less) often than usual for a stretch of the
    // window, on rows with every known mask applied: a false-zero era no mask covers yet.
    ...zeroEraAlarms(findZeroEras(trainingRows, LEARNER_FEATURE_NAMES)),
  ];
  if (alarms.length > 0) logger.warn("training run alarms", { alarms });
  const alarmMeta = alarms.length > 0 ? { alarms: alarms.join("; ") } : {};

  // The guard (curation/runGuard.ts): a plainly broken run - non-finite weights, a training set
  // that lost half its rows, every calling seat gone silent - keeps the running models instead.
  progress.stage("store models");
  if (env.CURATOR_TRAINING_GUARD) {
    const verdict = assessTrainingRun({
      // A seat that sat out keeps its running model, so it neither goes silent nor counts as a
      // running model this run replaces.
      incumbents: (await loadIncumbents()).filter(
        (m) => m.contestant === null || !kept.includes(m.contestant),
      ),
      results: results.map((r) => ({ contestant: r.contestant, kind: r.params.kind, params: r.params })),
      trainingRows: trainingRows.length,
      maxRows: env.CURATOR_TRAINING_MAX_ROWS,
      now: new Date(),
      maxHoldMs: env.CURATOR_GUARD_MAX_HOLD_HOURS * 3_600_000,
      rowRulesSince: TRAINING_ROW_RULES_SINCE,
    });
    if (!verdict.accept) {
      logger.warn("training run held back - keeping the running models", {
        reason: verdict.reason,
        heldForHours: Math.round(verdict.heldSinceMs / 360_000) / 10,
        rows: trainingRows.length,
      });
      return { stored: false, heldBack: verdict.reason, ...alarmMeta };
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
    return { stored: false, heldBack: "models were replaced while this run trained", ...alarmMeta };
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
  progress.stage("re-choose default");
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
    // Seats this run did not train (the 10× Hunter, when too few 10× verdicts are known).
    skipped: outcome.skipped,
    // Inputs held back as too new (or lately dead) to train on - see curation/featureOnset.ts.
    heldFeatures: learnerMetrics?.heldFeatures?.map((h) => ({
      feature: h.feature,
      referencePct: h.referencePct,
      recentPct: h.recentPct,
      // The age buckets that held it, when the pooled coverage alone did not.
      ...(h.buckets
        ? { buckets: h.buckets.map((b) => `${b.bucket} ${b.recentPct}% against ${b.referencePct}%`) }
        : {}),
    })),
    // The inputs' health this run: anything null on most rows, or with no lift at either end,
    // is a wire to check (see curation/featureReport.ts).
    featureReport: learnerMetrics?.featureReport
      ? {
          rows: learnerMetrics.featureReport.rows,
          mostlyNull: learnerMetrics.featureReport.features
            .filter((f) => !f.retired && (f.recentNullRatePct ?? f.nullRatePct) >= 90)
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
  return { stored: true, ...alarmMeta };
}

/** The running models' exam 2x records, for the regression alarm. */
async function loadIncumbentExams() {
  const rows = await prisma.curatorModel.findMany({
    where: { status: "active", contestant: { not: null } },
    select: { contestant: true, evalMetrics: true },
  });
  return rows.flatMap((r) => {
    const exam = (r.evalMetrics as Partial<StoredEvalMetrics> | null)?.exam;
    return exam && typeof exam.wins === "number" && typeof exam.graded === "number"
      ? [{ contestant: r.contestant!, wins: exam.wins, graded: exam.graded }]
      : [];
  });
}

/** The window the live-share alarm counts calls over. */
const LIVE_SHARE_WINDOW_HOURS = 6;
/** The window the fast-path record is read over: the seats' graded calls on entry rows. */
export const FAST_PATH_RECORD_WINDOW_HOURS = 72;

/** The two populations the seats decide on live, each with its own rows and its own share. */
const SHARE_POPULATIONS = [
  { kind: "event", label: "" },
  { kind: "entry", label: "fast path: " },
] as const;

/**
 * Each seat's live calls over the last few hours against the decision moments in them (alarm
 * only, runGuard.ts liveShareAlarms): a seat calling far more than its cutoff share, or most seats
 * gone quiet. Counted on the cycle's decision moments (event rows) and again on the fast path's
 * (entry rows, since 2026-10-26), each against its own moments: the fast path's cutoffs are read
 * on its own rows, so its share is judged there. Runs with the hourly champion refresh, which also
 * reads the seats' fast-path record (fastPathRecord).
 */
export async function seatLiveShareAlarms(
  env: Env,
  now = new Date(),
): Promise<{ shareAlarms?: string; fastPath?: Record<string, string | number> }> {
  let out: { shareAlarms?: string; fastPath?: Record<string, string | number> } = {};
  try {
    const alarms: string[] = [];
    for (const population of SHARE_POPULATIONS) {
      alarms.push(...(await countSeatShares(env, now, population.kind, population.label)));
    }
    if (alarms.length > 0) {
      logger.warn("seat live-share alarms", { alarms, windowHours: LIVE_SHARE_WINDOW_HOURS });
      out = { shareAlarms: alarms.join("; ") };
    }
  } catch (err) {
    // An alarm's own failure never fails the champion refresh it rides on.
    logger.warn("seat live-share check failed", { error: String(err) });
  }
  try {
    const fastPath = await fastPathRecord(now);
    if (fastPath !== null) {
      logger.info("fast-path record", { ...fastPath });
      out = { ...out, fastPath: fastPathMeta(fastPath) };
    }
  } catch (err) {
    logger.warn("fast-path record failed", { error: String(err) });
  }
  return out;
}

async function countSeatShares(
  env: Env,
  now: Date,
  kind: "event" | "entry",
  label: string,
): Promise<string[]> {
  const since = new Date(now.getTime() - LIVE_SHARE_WINDOW_HOURS * 3_600_000);
  const dayBefore = new Date(since.getTime() - 86_400_000);
  const [decisions, calls, before] = await Promise.all([
    prisma.candidateOutcome.count({ where: { sampleKind: kind, anchorAt: { gte: since, lt: now } } }),
    prisma.$queryRaw<{ model: string; calls: bigint }[]>`
      SELECT a."model", count(DISTINCT a."candidateOutcomeId") AS calls
      FROM "CuratedAlert" a
      JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId" AND co."sampleKind" = ${kind}
      WHERE a."createdAt" >= ${since} AND a."createdAt" < ${now}
      GROUP BY a."model"`,
    prisma.$queryRaw<{ model: string }[]>`
      SELECT DISTINCT a."model" FROM "CuratedAlert" a
      JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId" AND co."sampleKind" = ${kind}
      WHERE a."createdAt" >= ${dayBefore} AND a."createdAt" < ${since}`,
  ]);
  const called = new Map(calls.map((c) => [c.model, Number(c.calls)]));
  const earlier = new Set(before.map((b) => b.model));
  const seats = [...new Set([...called.keys(), ...earlier])].map((contestant) => ({
    contestant,
    calls: called.get(contestant) ?? 0,
    calledBefore: earlier.has(contestant),
  }));
  return liveShareAlarms(seats, decisions, env.CURATED_CUTOFF_TARGET_SHARE).map((a) => `${label}${a}`);
}

/**
 * The seats' record on the fast path's own decision moments (entry rows) over the last
 * FAST_PATH_RECORD_WINDOW_HOURS: the moments, how many are graded and doubled (the base every
 * fast-path call has to beat), and per seat its distinct calls there, graded and clean 2x wins.
 * The exam cannot see these moments (it grades event rows), so this is the fast path's exam,
 * read on the live record and written to the champion refresh's heartbeat.
 */
export interface FastPathRecord {
  windowHours: number;
  moments: number;
  graded: number;
  won2x: number;
  seats: { contestant: string; calls: number; graded: number; won2x: number }[];
}

/** The record as the heartbeat stores it: the moments' figures, and each seat's on one line. */
export function fastPathMeta(record: FastPathRecord): Record<string, string | number> {
  return {
    windowHours: record.windowHours,
    moments: record.moments,
    graded: record.graded,
    won2x: record.won2x,
    seats: record.seats.map((s) => `${s.contestant} ${s.won2x}/${s.graded} of ${s.calls}`).join("; "),
  };
}

export async function fastPathRecord(now = new Date()): Promise<FastPathRecord | null> {
  const since = new Date(now.getTime() - FAST_PATH_RECORD_WINDOW_HOURS * 3_600_000);
  const [moments, seats] = await Promise.all([
    prisma.$queryRaw<{ moments: bigint; graded: bigint; won: bigint }[]>`
      SELECT count(*) AS moments,
             count(*) FILTER (WHERE "hit2xIn1h" IS NOT NULL) AS graded,
             count(*) FILTER (WHERE "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS won
      FROM "CandidateOutcome"
      WHERE "sampleKind" = 'entry' AND "anchorAt" >= ${since} AND "anchorAt" < ${now}`,
    prisma.$queryRaw<{ model: string; calls: bigint; graded: bigint; won: bigint }[]>`
      SELECT a."model",
             count(DISTINCT a."candidateOutcomeId") AS calls,
             count(DISTINCT a."candidateOutcomeId") FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
             count(DISTINCT a."candidateOutcomeId")
               FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won
      FROM "CuratedAlert" a
      JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId" AND co."sampleKind" = 'entry'
      WHERE a."createdAt" >= ${since} AND a."createdAt" < ${now}
      GROUP BY a."model" ORDER BY a."model"`,
  ]);
  const total = moments[0];
  if (total === undefined || Number(total.moments) === 0) return null;
  return {
    windowHours: FAST_PATH_RECORD_WINDOW_HOURS,
    moments: Number(total.moments),
    graded: Number(total.graded),
    won2x: Number(total.won),
    seats: seats.map((s) => ({
      contestant: s.model,
      calls: Number(s.calls),
      graded: Number(s.graded),
      won2x: Number(s.won),
    })),
  };
}

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
    rules: { minLiveGraded: env.CURATOR_CHAMPION_MIN_LIVE_GRADED, margin: env.CURATOR_CHAMPION_MARGIN },
    targets: curatedTargets(env),
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
        const withMembers = params as
          StackedCuratorParams | BlendCuratorParams | AgreementCuratorParams | TopSliceCuratorParams;
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
 * it was picked - are scored once on the decision moments that arrived since, each calling the
 * field's target share of them and judged on its 2x rate there: a pass seats the challenger this
 * run, anything else retires the probation. Before then the run waits (no breeding: one takeover
 * is already in hand). A seat that changed hands meanwhile (a restore), or probation turned off,
 * abandons it.
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
    share: targets.targetShare ?? 0,
    minWins: env.CURATOR_EVOLUTION_PROBATION_MIN_WINS,
    goal: lane.recipe.goal,
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
      challengerGoals: challengers.map((c) => c.recipe.goal),
      evidence: {
        minExamWins: env.CURATOR_EVOLUTION_MIN_EXAM_WINS,
        confidence: env.CURATOR_EVOLUTION_CONFIDENCE,
        lastTakeoverAt: lastTakeover._max.bornAt ?? null,
        minTakeoverIntervalMs: env.CURATOR_EVOLUTION_MIN_TAKEOVER_INTERVAL_HOURS * 3_600_000,
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
  const [live, active, catches] = await Promise.all([
    liveCallRecords(
      lanes.map((l) => l.slot),
      since,
      lanes,
    ),
    prisma.curatorModel.findMany({
      where: { status: "active", contestant: { in: lanes.map((l) => l.slot) } },
      select: { contestant: true, evalMetrics: true },
    }),
    // Live catch, as the board scores it (withLiveCatch).
    liveCatchRates(
      lanes.map((l) => l.slot),
      since,
      lanes,
    ),
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
      withLiveCatch(live.get(lane.slot) ?? emptyRecord(), catches.byModel.get(lane.slot)),
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
  /**
   * excludeFineTickLabels: drop rule-5 rows (CURATOR_EXCLUDE_FINE_TICK_LABELS). Default keeps
   * them, the same fit as before the flag existed. tokenSageXReuseRestoredAt: where the
   * X-reuse and wave inputs' lost window ends (TOKENSAGE_XREUSE_RESTORED_AT); unset, it is open.
   */
  opts?: LoadRowsOptions,
): Promise<TrainingRow[]> {
  const [events, alerted] = await Promise.all([
    loadRowsOfKind("event", windowStart, maxRows, pageRows, undefined, opts),
    alertedEventAnchors(windowStart),
  ]);
  // The fast path's rows, when asked for: banked seconds into the band, before any hourly row of
  // the coin, so they are no twin of one.
  const entries =
    opts?.trainOnEntryRows === true
      ? await loadRowsOfKind("entry", windowStart, Math.max(0, maxRows - events.length), pageRows, band, opts)
      : [];
  const hourly = withoutEventTwins(
    await loadRowsOfKind(
      "hourly",
      windowStart,
      maxRows - events.length - entries.length,
      pageRows,
      band,
      opts,
    ),
    events.map((e) => ({
      tokenId: e.tokenId,
      anchorAt: e.anchorAt,
      anchorPriceUsd: e.anchorPriceUsd,
      alerted: e.tokenId !== undefined && alerted.has(anchorKey(e.tokenId, e.anchorAt)),
    })),
  );
  // Newest first, as a single newest-first query would have returned them; ties keep events first.
  return [...events, ...entries, ...hourly].sort((a, b) => b.anchorAt.getTime() - a.anchorAt.getTime());
}

/** An hourly row this close to one of its token's event rows was banked from the same scan. */
const TWIN_WINDOW_MS = 5_000;
/**
 * How far an alerted event row's anchor can have moved past its scan. Alerts sent before the
 * label clock stayed on the decision anchor were restamped at send time (emitCuratedAlert) while
 * the scan price stayed. New alerts are not restamped; the window still drops those older twins.
 */
const MOVED_TWIN_WINDOW_MS = 180_000;

/**
 * The scan banks a token's hourly row and its event row from the same scored token when both are
 * due in one cycle, so the moment would sit in the training set twice (a fifth of event rows had
 * such a twin, 2026-10-08). The event row is the one the exam reads; its hourly twin goes. An
 * alerted event's anchor moves to send time, so a twin is also an hourly row up to a few minutes
 * before its token's event with the same scan price - else the models' own picks train twice.
 * The price can't be relied on for a row re-graded from candles (its price is the replay's candle
 * at its own anchor, and the moved anchor usually lands on another minute), so before an event
 * known to be alerted (`alerted`) any hourly row in those few minutes is its twin, whatever the price.
 */
export function withoutEventTwins<T extends { tokenId?: string; anchorAt: Date; anchorPriceUsd?: number }>(
  hourly: readonly T[],
  events: readonly { tokenId?: string; anchorAt: Date; anchorPriceUsd?: number; alerted?: boolean }[],
): T[] {
  const eventsByToken = new Map<string, { t: number; price?: number; alerted: boolean }[]>();
  for (const e of events) {
    // A row with no token can't be matched to anything, so it is never anyone's twin.
    if (e.tokenId === undefined) continue;
    const list = eventsByToken.get(e.tokenId) ?? [];
    list.push({ t: e.anchorAt.getTime(), price: e.anchorPriceUsd, alerted: e.alerted === true });
    eventsByToken.set(e.tokenId, list);
  }
  return hourly.filter((h) => {
    const list = h.tokenId === undefined ? undefined : eventsByToken.get(h.tokenId);
    const t = h.anchorAt.getTime();
    return !list?.some(
      (e) =>
        Math.abs(e.t - t) < TWIN_WINDOW_MS ||
        ((e.alerted || (h.anchorPriceUsd !== undefined && e.price === h.anchorPriceUsd)) &&
          e.t >= t &&
          e.t - t <= MOVED_TWIN_WINDOW_MS),
    );
  });
}

const anchorKey = (tokenId: string, anchorAt: Date) => `${tokenId}@${anchorAt.getTime()}`;

/**
 * The event rows in the window a curated alert points at, as anchorKey: the ones whose anchor
 * emitCuratedAlert moved to send time (withoutEventTwins). One row per alerted moment in the window.
 */
async function alertedEventAnchors(windowStart: Date): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ tokenId: string; anchorAt: Date }[]>`
    SELECT DISTINCT co."tokenId", co."anchorAt"
    FROM "CuratedAlert" a
    JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId" AND co."sampleKind" = 'event'
    WHERE a."createdAt" >= ${windowStart} AND co."anchorAt" >= ${windowStart}`;
  return new Set(rows.map((r) => anchorKey(r.tokenId, r.anchorAt)));
}

/**
 * The Narrative seat's second looks (curation/contestants.ts): the rows the scan took when a deep
 * read landed after a token's last decision. They count as decision moments for this seat alone,
 * so they are relabeled "event" here and nowhere else. The seat's full training set (these plus
 * every row of the run) is put together in the training thread (narrativeTrainingSet).
 */
export async function narrativeTrainingRows(
  windowStart: Date,
  maxRows: number,
  pageRows = LOAD_PAGE_ROWS,
  opts?: Pick<LoadRowsOptions, "tokenSageXReuseRestoredAt">,
): Promise<TrainingRow[]> {
  return (
    (await loadRowsOfKind("second", windowStart, maxRows, pageRows, undefined, opts))
      .filter((r) => r.features.nsDepthFull === 1)
      .map((r) => ({ ...r, sampleKind: "event" }))
      // Held to today's decision pre-gate as an event row is (the 3h age cap, the old-coin
      // momentum test): second looks banked under the older 6h cap can't be decided on any more.
      .filter((r) => isDecisionRow(r))
  );
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
 *
 * The peak before the stop where it was tracked (peakBeforeStopPriceUsd, what labelValue is
 * graded on), not the whole window's: a coin that 2x'd, fell through 0.5x and ran 10x afterwards
 * was a 2x to anyone holding the alert, and crediting the later run trained it as a big winner
 * (user decision 2026-10-09). The two are the same on every row that never hit the stop.
 */
export function runPeakOf(r: {
  peak1hReturnPct: number | null;
  peakBeforeStopPriceUsd: number | null;
  anchorPriceUsd: number;
}): { runPeakMultiple?: number } {
  if (r.peakBeforeStopPriceUsd !== null && r.anchorPriceUsd > 0) {
    return { runPeakMultiple: r.peakBeforeStopPriceUsd / r.anchorPriceUsd };
  }
  return r.peak1hReturnPct !== null ? { runPeakMultiple: 1 + r.peak1hReturnPct / 100 } : {};
}

/** How long after the trail's hold cap a watcher price still counts as the price at the cap. */
const HOLD_CAP_PRICE_SLACK_MS = 30 * 60_000;

/**
 * TrainingRow.returnPct and .crashed for a stored row, under today's exit plan (EXIT_PLAN): the
 * plan replayed on the row's own aggregates (the ladder on the peak before the stop, the stop,
 * the trail's exit), so the ladder and the stop are priced the same way whichever plan was current
 * when the row was graded. The trail's exit is the one the watcher kept for the plan of the day,
 * so on rows graded before a trail change the trailing share is approximate.
 *
 * Where the replay can't finish on the aggregates alone:
 *  - Nothing sold and no stop: the row closed at the label window's price, which is not stored,
 *    so it reads its stored return - with no sale and no stop every plan closes it at that price.
 *  - Something sold and the trail never fired (it rode to the hold cap, or the row predates the
 *    trail state): the rest closes at a real price the row stores - the watcher's last price, when
 *    it was taken within HOLD_CAP_PRICE_SLACK_MS after the hold cap, or, on a row whose watch ended
 *    at the label window's close (no trail state, not on the 24h watch), that close. Without one
 *    the return is left unknown: the stored return was priced under the plan of its day.
 */
export function rowReturn(
  r: {
    anchorAt: Date;
    anchorPriceUsd: number;
    low1hPriceUsd: number | null;
    peak1hPriceUsd: number | null;
    peakBeforeStopPriceUsd: number | null;
    stoppedAt: Date | null;
    trailHighPriceUsd: number | null;
    trailExitAt: Date | null;
    trailExitPriceUsd: number | null;
    simReturnPct: number | null;
    lastPriceUsd?: number | null;
    lastCheckedAt?: Date | null;
    extended24h?: boolean | null;
  },
  /** The exit plan re-score's return for the row (ExitPlanRescore), which stands over a replay. */
  rescoredReturnPct: number | null = null,
): { returnPct?: number; crashed?: boolean } {
  const crashLine = (EXIT_PLAN.stopFraction - 1) * 100 + 1e-6;
  const known = (returnPct: number | null) =>
    returnPct === null || !Number.isFinite(returnPct) ? {} : { returnPct, crashed: returnPct <= crashLine };
  if (rescoredReturnPct !== null && Number.isFinite(rescoredReturnPct)) return known(rescoredReturnPct);
  if (r.low1hPriceUsd === null || r.peak1hPriceUsd === null) return known(r.simReturnPct);
  const input = {
    anchorPriceUsd: r.anchorPriceUsd,
    low1hPriceUsd: r.low1hPriceUsd,
    peak1hPriceUsd: r.peak1hPriceUsd,
    peakBeforeStopPriceUsd: r.peakBeforeStopPriceUsd,
    stoppedAt: r.stoppedAt,
    trailHighPriceUsd: r.trailHighPriceUsd,
    trailExitAt: r.trailExitAt,
    trailExitPriceUsd: r.trailExitPriceUsd,
  };
  const replayed = simulateExitPlan(input, null);
  if (replayed !== null) return known(replayed);
  // Sold, with the trail still holding the rest: close it at the cap price, when one is stored.
  if (exitPlanPositionOpen({ ...input, simReturnPct: null })) {
    const capPrice = holdCapPriceUsd(r);
    const capped = capPrice === null ? null : simulateExitPlan(input, null, EXIT_PLAN, capPrice);
    // It sold before any stop, so it did not crash whatever the rest fetched.
    return capped === null || !Number.isFinite(capped) ? { crashed: false } : known(capped);
  }
  return known(r.simReturnPct);
}

/** The real price rowReturn closes a trailing share at (see there), or null. */
function holdCapPriceUsd(r: Parameters<typeof rowReturn>[0]): number | null {
  const price = r.lastPriceUsd ?? null;
  const at = r.lastCheckedAt ?? null;
  if (price === null || !(price > 0) || !Number.isFinite(price) || at === null) return null;
  const sinceAnchor = at.getTime() - r.anchorAt.getTime();
  const capMs = EXIT_PLAN.trailMaxHoldMinutes * 60_000;
  if (sinceAnchor >= capMs && sinceAnchor <= capMs + HOLD_CAP_PRICE_SLACK_MS) return price;
  // A row from before the trail state whose watch ended when the label window closed.
  if (r.trailHighPriceUsd === null && r.extended24h === false && sinceAnchor <= capMs) return price;
  return null;
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
  peakBeforeStopPriceUsd: number | null;
  hit10xIn1h: boolean | null;
  low1hPriceUsd: number | null;
  peak1hPriceUsd: number | null;
  stoppedAt: Date | null;
  trailHighPriceUsd: number | null;
  trailExitAt: Date | null;
  trailExitPriceUsd: number | null;
  simReturnPct: number | null;
  lastPriceUsd: number | null;
  lastCheckedAt: Date | null;
  extended24h: boolean;
  rule4Grade: unknown;
  /** Set when the row was born rule 3 and the re-grade rewrote it in place (labelRegradeJob.ts). */
  rule3Grade: unknown;
  /** The token's launch time (Token.launchedAt), for the rebuilt age of an older graduated row. */
  launchedAt: Date | null;
  /** The return the exit plan re-score replayed from candles (ExitPlanRescore), when it did. */
  rescoredReturnPct: number | null;
}

/** The grade fields trainingGradeOf reads from a stored rule4Grade. */
type GradedFields = Pick<
  LoadedRow,
  | "labelValue"
  | "labelRule"
  | "anchorPriceUsd"
  | "signalPriceUsd"
  | "anchorMcapUsd"
  | "maxDrawdown1hPct"
  | "peak1hReturnPct"
  | "peakBeforeStopPriceUsd"
  | "hit10xIn1h"
> &
  Partial<
    Pick<
      LoadedRow,
      | "low1hPriceUsd"
      | "peak1hPriceUsd"
      | "stoppedAt"
      | "trailHighPriceUsd"
      | "trailExitAt"
      | "trailExitPriceUsd"
      | "simReturnPct"
    >
  >;

/**
 * The grade a row trains and is examined on. A row a curated alert points at keeps the rule-3
 * verdict the alert was published with, and its rule-4 re-grade sits in rule4Grade
 * (labelRegradeJob.ts): that one is read instead, with its fresh-price gap, so the moments the
 * models called are graded on the same rule as the rest. An alerted row born rule 4 can carry one
 * too: the quote re-grade's candle replay (quoteRegrade.ts), for a coin whose price read $0 while
 * it was watched. That replay is read as well, but the row keeps its own freshGapPct: it is the
 * live quote's gap, already rule 4's. A re-graded rule-3 row's freshGapPct reads as missing when
 * it does not scale a stored cap onto the fresh anchor (a candle from the alert's moved send-time
 * anchor, after the decision). The gap that is that anchor is kept. maskKnownBadInputs nulls the
 * gap on every row before FRESH_QUOTE_GAP_SINCE as well. Every other row is returned as it is.
 */
function freshGapDefinesAnchor(
  gapPct: number | null | undefined,
  anchorMcapUsd: number,
  bases: readonly (number | null | undefined)[],
): boolean {
  if (typeof gapPct !== "number" || !Number.isFinite(gapPct) || !(anchorMcapUsd > 0)) return false;
  const ratio = 1 + gapPct / 100;
  if (!(ratio > 0)) return false;
  return bases.some((base) => {
    if (typeof base !== "number" || !(base > 0)) return false;
    return Math.abs(base * ratio - anchorMcapUsd) / anchorMcapUsd <= 1e-4;
  });
}

export function trainingGradeOf<R extends GradedFields & { features: unknown; rule4Grade: unknown }>(
  r: R,
): R {
  const g = r.rule4Grade;
  const born4 = r.labelRule === FRESH_ANCHOR_LABEL_RULE;
  if ((r.labelRule !== 3 && !born4) || g === null || typeof g !== "object") return r;
  const grade = g as Record<string, unknown>;
  if (typeof grade.labelValue !== "number" || typeof grade.anchorPriceUsd !== "number") return r;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const dateOf = (v: unknown): Date | null => {
    if (v instanceof Date) return v;
    if (typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    ...r,
    labelRule: FRESH_ANCHOR_LABEL_RULE,
    labelValue: grade.labelValue,
    anchorPriceUsd: grade.anchorPriceUsd,
    signalPriceUsd: num(grade.signalPriceUsd),
    anchorMcapUsd: num(grade.anchorMcapUsd) ?? r.anchorMcapUsd,
    maxDrawdown1hPct: num(grade.maxDrawdown1hPct),
    peak1hReturnPct: num(grade.peak1hReturnPct),
    peakBeforeStopPriceUsd: num(grade.peakBeforeStopPriceUsd),
    hit10xIn1h: typeof grade.hit10xIn1h === "boolean" ? grade.hit10xIn1h : null,
    low1hPriceUsd: num(grade.low1hPriceUsd),
    peak1hPriceUsd: num(grade.peak1hPriceUsd),
    stoppedAt: dateOf(grade.stoppedAt),
    trailHighPriceUsd: num(grade.trailHighPriceUsd),
    trailExitAt: dateOf(grade.trailExitAt),
    trailExitPriceUsd: num(grade.trailExitPriceUsd),
    simReturnPct: num(grade.simReturnPct),
    features: born4
      ? r.features
      : {
          ...(r.features as Record<string, number | null>),
          // The gap stays when it is the move from a stored cap onto this fresh anchor.
          // One measured on a later candle, that does not scale to the anchor, reads as missing.
          freshGapPct: freshGapDefinesAnchor(
            num(grade.freshGapPct),
            num(grade.anchorMcapUsd) ?? r.anchorMcapUsd,
            [(r.features as Record<string, number | null>).mcapUsd, r.anchorMcapUsd],
          )
            ? num(grade.freshGapPct)
            : null,
        },
  };
}

/** A background row of a coin with no trading in its hour: no 1h volume and no 1h buys recorded as 0. */
export function isFrozenCurveRow(features: unknown): boolean {
  if (typeof features !== "object" || features === null) return false;
  const f = features as Record<string, unknown>;
  return f.volume1hUsd === 0 && f.buys1h === 0;
}

/** Every name a stored vector can carry, in vector order: the shape withFixedShape builds. */
const STORED_FEATURE_NAMES: readonly string[] = [
  ...new Set<string>([...CANDIDATE_FEATURE_NAMES, ...ALL_NARRATIVE_FEATURES]),
];
const STORED_FEATURE_SET: ReadonlySet<string> = new Set(STORED_FEATURE_NAMES);
/** Spread per row, so every row starts from the one hidden class with all the names in place. */
const FEATURES_TEMPLATE: Readonly<Record<string, undefined>> = Object.fromEntries(
  STORED_FEATURE_NAMES.map((name) => [name, undefined]),
);

/**
 * A stored vector rebuilt with one fixed shape. Parsed from jsonb, a vector of ~148 keys is a
 * dictionary-mode object in V8: about 7.8KB a row against 2.8KB with one shape (a synthetic full
 * vector, node 22), several hundred MB at the 100k row cap on a 2GB trainer. Copied onto a
 * template of every feature name, each row is a plain object sharing one hidden class. Reads are
 * unchanged: a name the row never stored reads undefined, as it did before (it is now an own key
 * holding undefined, which nothing over the rows tells apart, and JSON drops). Keys outside the
 * lists - a retired input on an old row - are kept as they were.
 */
export function withFixedShape<T>(stored: T): T {
  if (typeof stored !== "object" || stored === null) return stored;
  const src = stored as Record<string, unknown>;
  const out: Record<string, unknown> = { ...FEATURES_TEMPLATE };
  for (const name of STORED_FEATURE_NAMES) out[name] = src[name];
  for (const key of Object.keys(src)) if (!STORED_FEATURE_SET.has(key)) out[key] = src[key];
  return out as T;
}

/** The row's token's launch time, as a scalar subquery on the unaliased CandidateOutcome row. */
const launchedAtSql = Prisma.sql`SELECT t."launchedAt" FROM "Token" t WHERE t."id" = "CandidateOutcome"."tokenId"`;

/** What loadTrainingRows and narrativeTrainingRows take from the run's settings. */
interface LoadRowsOptions {
  excludeFineTickLabels?: boolean;
  tokenSageXReuseRestoredAt?: Date | null;
  /**
   * Load the fast path's decision rows ("entry") too (CURATOR_TRAIN_ON_ENTRY_ROWS). They join the
   * fit as rows the exam does not grade (isDecisionRow knows "event" and "hourly"), the way
   * background rows do: the seats then see the inputs a seconds-old coin has.
   */
  trainOnEntryRows?: boolean;
}

async function loadRowsOfKind(
  sampleKind: "hourly" | "event" | "second" | "entry",
  windowStart: Date,
  maxRows: number,
  pageRows: number,
  band?: { min: number; max: number },
  opts?: LoadRowsOptions,
): Promise<TrainingRow[]> {
  // Background rows are banked across the padded scan band, but no call is ever made outside the
  // curated band: half of them sat under its floor (2026-10-08), teaching a market nobody trades.
  // Banded on the scan's own market cap, the one the live gate read: the anchor cap is the fresh
  // quote's, which let 1,459 rows of coins under the $10k floor in (19% of hourly rows, doubling
  // 18.1% against 8.9%, with inputs no decision row ever lacks) - data-correctness audit 2026-10-16.
  const bandSql =
    band !== undefined
      ? Prisma.sql`AND COALESCE(("features"::jsonb ->> 'mcapUsd')::float8, "anchorMcapUsd") BETWEEN ${band.min} AND ${band.max}`
      : Prisma.empty;
  // Decision moments older than the event pre-gate's age cap were banked before the cap existed
  // (2026-10-05): a live decision can no longer be one, so they neither train nor grade.
  // Background rows are held to the same cap (data-correctness audit 2026-10-16): 27% of them
  // were coins over six hours old doubling about 1%, a market no decision can come from. The cap
  // itself is 3 hours since 2026-10-16 (age-cap experiment, same note folder). The Narrative
  // seat's second looks are decision moments for that seat and are held to it too. On a graduated
  // row banked before AGE_FROM_LAUNCH_SINCE the stored age may be the pool's, so the cap reads the
  // age rebuilt from the launch where the Token has one, as withLaunchAge rebuilds the input.
  const ageSql = Prisma.sql`AND COALESCE(
      CASE WHEN "anchorAt" < ${AGE_FROM_LAUNCH_SINCE}
        AND ("features"::jsonb ->> 'graduated')::float8 = 1
        AND ("features"::jsonb ->> 'ageSource') IS NULL
        AND ("features"::jsonb ->> 'ageMinutes') IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM ("anchorAt" - (${launchedAtSql}))) / 60) END,
      ("features"::jsonb ->> 'ageMinutes')::float8,
      0
    ) <= ${MAX_EVENT_AGE_MINUTES}`;
  const out: TrainingRow[] = [];
  let cursor: { anchorAt: Date; id: string } | undefined;
  let pages = 0;
  while (out.length < maxRows && pages < LOAD_MAX_PAGES) {
    pages += 1;
    const take = Math.min(pageRows, maxRows - out.length);
    // Keyset-paged on (anchorAt, id), newest first. The safety screen's cut is applied to each
    // row after its inputs are masked (below), not in the query: live, the screen reads the
    // inputs as they mean today.
    const page = await prisma.$queryRaw<LoadedRow[]>`
      SELECT "id", "tokenId", "anchorAt", "features", "labelValue", "anchorPriceUsd",
             "signalPriceUsd", "anchorMcapUsd", "sampleKind", "labelRule", "maxDrawdown1hPct",
             "peak1hReturnPct", "peakBeforeStopPriceUsd", "hit10xIn1h", "low1hPriceUsd",
             "peak1hPriceUsd", "stoppedAt", "trailHighPriceUsd", "trailExitAt", "trailExitPriceUsd",
             "simReturnPct", "lastPriceUsd", "lastCheckedAt", "extended24h", "rule4Grade", "rule3Grade",
             (${launchedAtSql}) AS "launchedAt",
             (SELECT x."simReturnPct" FROM "ExitPlanRescore" x
               WHERE x."outcomeId" = "CandidateOutcome"."id" AND x."result" = 'rescored') AS "rescoredReturnPct"
      FROM "CandidateOutcome"
      WHERE "finalizedAt" IS NOT NULL
        AND "anchorAt" >= ${windowStart}
        AND "sampleKind" = ${sampleKind}
        ${bandSql}
        ${ageSql}
        ${cursor !== undefined ? Prisma.sql`AND ("anchorAt", "id") < (${cursor.anchorAt}, ${cursor.id})` : Prisma.empty}
      ORDER BY "anchorAt" DESC, "id" DESC
      LIMIT ${take}`;
    for (const loaded of page) {
      const r = trainingGradeOf(loaded);
      // A row the rule-4 re-grade never reached stays out of the fit, as it stays out of the exam:
      // which rows it skipped depended on the outcome (busy runners outgrew the candle history,
      // old flat coins never traded), so young skipped decision rows doubled 23.4% against 17.3%
      // for re-graded ones while skipped hourly rows doubled 3.9% (data-correctness audit
      // 2026-10-16). Since 2026-10-12 a row is born rule 3 only when the scan had no usable fresh
      // quote (1-3% of decision rows a day); the re-grade then rewrites it in place.
      if (!trainsOnLabelRule(r.labelRule, opts?.excludeFineTickLabels === true)) continue;
      // A completed curve nobody trades (no volume, no buys in the hour) reads a frozen market cap
      // near $49.6k and stale holder figures, and never moves: 5,523 hourly rows on 10-06..10-11
      // taught the band where live near-graduation coins sit that it never doubles.
      if (r.sampleKind === "hourly" && isFrozenCurveRow(r.features)) continue;
      // Stonks rows from before the fee wallet left their holder figures (2026-10-16).
      if (isPreFeeWalletStonksRow(r.anchorAt, r.features as Record<string, number | null>)) continue;
      // Inputs known to be wrong on old rows (fake order-flow zeros, the inputs hourly rows were
      // banked ahead of until HOURLY_ROWS_WAIT_SINCE) read as missing.
      const stored = withFixedShape(r.features as Record<string, number | null>);
      // And TokenSage's X-reuse and wave counts while they were lost (TOKENSAGE_XREUSE_LOST_FROM):
      // a false 0 there would teach "no wave" and fix the cutoffs on it.
      const masked = maskTokenSageXReuseLoss(
        r.anchorAt,
        maskKnownBadInputs(r.anchorAt, stored, sampleKind),
        opts?.tokenSageXReuseRestoredAt ?? null,
      );
      // A token the safety screen rejects today never reaches a curator, so a row banked before
      // the cut was tightened (mostly farm launches that pump, then rug) neither trains nor grades.
      // Judged on the inputs as they mean today (an era-masked input is unknown, and the screen
      // passes an unknown), so the row set matches what the live screen lets through. Not on the
      // hourly-wait mask: that one hides readings that were real when present.
      if (
        !passesWalletSafetyCuts(sampleKind === "hourly" ? maskKnownBadInputs(r.anchorAt, stored) : masked)
      ) {
        continue;
      }
      // An older graduated row's age as live reads it today: from the launch, not the pool. A row
      // whose true age is unknown and may be past the age cap leaves the set.
      const launched = withLaunchAge(r.anchorAt, masked, loaded.launchedAt);
      if (launched === null) continue;
      // A pair age banked before #896 can be a junk pool's clock. Cleared after withLaunchAge,
      // which still needs it to drop a pool-aged row whose launch time is unknown.
      const dated = withoutPreCanonicalPairAge(r.anchorAt, launched);
      // A row re-graded in place (born rule 3 after the fresh quotes began, no usable quote at the
      // scan) had its fresh-price gap overwritten with the candle re-grade's. That gap stays when
      // it is the move onto the fresh anchor the row stored. A gap that does not scale to that
      // anchor was measured off the decision and reads as missing, as a live no-quote row does.
      if (loaded.rule3Grade !== null && dated.freshGapPct !== undefined) {
        const old = loaded.rule3Grade as Record<string, unknown>;
        const oldAnchor = typeof old.anchorMcapUsd === "number" ? old.anchorMcapUsd : null;
        if (!freshGapDefinesAnchor(dated.freshGapPct, r.anchorMcapUsd, [dated.mcapUsd, oldAnchor])) {
          dated.freshGapPct = null;
        }
      }
      // The named windows are "since the pair opened" on a young pair. Fill the per-minute and
      // full-window readings from inputs this row already stored (curation/clockFeatures.ts).
      // The row's anchor cap is the fresh one a regrade stored; the clock block must not rebuild
      // the decision cap from the raw scan cap instead.
      const features = applyClockFeatures(dated, r.anchorMcapUsd);
      // The gated seats' filters read what the row stored for the transfer-linked inputs the mask
      // cleared (TrainingRow.gateInputs, user decision 2026-10-20).
      let gateInputs: Record<string, number | null> | undefined;
      if (masked !== stored) {
        for (const name of HOLDER_TRANSFER_LINKED_FEATURES) {
          if (masked[name] == null && stored[name] != null) (gateInputs ??= {})[name] = stored[name];
        }
      }
      const row: TrainingRow = {
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
        // The return under today's exit plan and whether it fell to the stop first: what the
        // "return" and "safe" goals train on and every exam's average return (rowReturn). A row
        // the exit plan re-score replayed from candles takes that return (user ask 2026-10-18),
        // when it is graded from the same price the re-score replayed from.
        ...rowReturn(r, r.anchorPriceUsd === loaded.anchorPriceUsd ? loaded.rescoredReturnPct : null),
        ...(gateInputs !== undefined ? { gateInputs } : {}),
      };
      // The decision pre-gate's old-coin momentum test (#567) re-applied, as the exam does: the
      // 1,942 older rows that fail it today doubled 1.8% and held 9.6% of the training weight.
      if (row.sampleKind === "event" && !isDecisionRow(row)) continue;
      out.push(row);
    }
    if (page.length < take) break;
    const last = page[page.length - 1]!;
    cursor = { anchorAt: last.anchorAt, id: last.id };
  }
  // The count that is true after the screen's cut, which is the set that trains.
  logger.info("loaded training rows", { sampleKind, rows: out.length, pages, capped: out.length >= maxRows });
  return out;
}
