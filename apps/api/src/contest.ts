import {
  prisma,
  compositeScore,
  defaultContestant,
  loadChampion,
  resolveDefaultModel,
  resolveFeedModels as resolveFeedModelsShared,
  emptyRecord,
  enabledContestants,
  liveCallRecords,
  loadCurrentLanes,
  rankByComposite,
  withLanes,
  CONSENSUS_CONTESTANT,
  BACKTEST_EVIDENCE_CAP,
  MIN_LIVE_CALLS_TO_RANK,
  COMPOSITE_WEIGHTS,
  RUN_SIZE_TARGET_DOUBLINGS,
  TEN_X_TARGET_RATE,
  PRIOR_CALLS,
  SCORE_BANDS,
  explainScore,
  describeExitPlan,
  NEVER_EMIT_THRESHOLD,
  summarizeRecord,
  type ChampionRecord,
  type CompositeScore,
  type RecordSummary,
  type ContestantSpec,
  type Env,
  type Lane,
  type PrecisionTargets,
  type StoredEvalMetrics,
} from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";
import type { FastifyRequest } from "fastify";

/**
 * The curator contest as the API serves it: which contestant's calls are the default feed, which
 * one a user picked, and the leaderboard ranking every contestant on its composite score
 * (curation/leaderboard.ts). Names and ids come from the one roster in curation/contestants.ts,
 * so the selector and the leaderboard can never disagree about what a model is called.
 */

/** How long the roster state (current model per contestant) is reused - it changes per training run. */
const STATE_CACHE_TTL_MS = 60_000;

export interface ContestantModel {
  id: string;
  kind: string;
  trainedAt: Date;
  trainingRows: number;
  /** Null for the rules contestant, whose cutoff is in rank-score units. */
  threshold: number | null;
  metrics: Partial<StoredEvalMetrics>;
}

export interface ContestState {
  /** The enabled roster, in canonical order - learner seats under their current lane's name. */
  roster: ContestantSpec[];
  /** Each evolving seat's current lane. */
  lanes: Lane[];
  /** Each contestant's current (active) model row, when it has one. */
  current: Map<string, ContestantModel>;
  /** Whose calls a user who hasn't picked sees: the champion while it can call, else the fallback. */
  defaultModel: string;
  /** The stored best-performer pick (curation/champion.ts); null before the first one. */
  champion: ChampionRecord | null;
}

/**
 * Every feed and panel request reads this first, so a reader must never wait out its refresh: a
 * stale roster is served while the new one loads. It changes per training run (every few hours),
 * so the one request answered from the old one costs nothing anyone could notice.
 */
const STATE_STALE_MS = 3_600_000;

const stateCache = new SharedCache<ContestState>(STATE_CACHE_TTL_MS, {
  staleWhileRevalidateMs: STATE_STALE_MS,
});

/** Test hook. */
export function resetContestStateCache(): void {
  stateCache.clear();
}

export function contestState(env: Env): Promise<ContestState> {
  return stateCache.get(async () => {
    const [lanes, champion] = await Promise.all([loadCurrentLanes(), loadChampion()]);
    const roster = withLanes(enabledContestants(env.CURATOR_CONTESTANTS), lanes);
    const rows = await prisma.curatorModel.findMany({
      where: { status: "active", contestant: { in: roster.map((c) => c.id) } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        contestant: true,
        kind: true,
        createdAt: true,
        trainingRows: true,
        evalMetrics: true,
      },
    });
    // Only the cutoff is read off params, and params is the whole model (a GBDT's forest runs to
    // megabytes): pull the one number out in SQL instead of shipping every model's weights here.
    const thresholds = new Map(
      rows.length === 0
        ? []
        : (
            await prisma.$queryRaw<{ id: string; threshold: number | null }[]>`
              SELECT "id",
                     CASE WHEN jsonb_typeof("params"->'threshold') = 'number'
                          THEN ("params"->>'threshold')::float8 END AS threshold
              FROM "CuratorModel"
              WHERE "id" = ANY(${rows.map((r) => r.id)})`
          ).map((r) => [r.id, r.threshold] as const),
    );
    const current = new Map<string, ContestantModel>();
    for (const row of rows) {
      if (!row.contestant || current.has(row.contestant)) continue;
      const threshold = thresholds.get(row.id);
      current.set(row.contestant, {
        id: row.id,
        kind: row.kind,
        trainedAt: row.createdAt,
        trainingRows: row.trainingRows,
        threshold: typeof threshold === "number" ? threshold : null,
        metrics:
          typeof row.evalMetrics === "object" && row.evalMetrics !== null
            ? (row.evalMetrics as Partial<StoredEvalMetrics>)
            : {},
      });
    }
    const consensusEnabled = roster.some((c) => c.id === CONSENSUS_CONTESTANT);
    const canCall = (id: string) => {
      const spec = roster.find((c) => c.id === id);
      if (!spec) return false;
      if (spec.role === "rules") return true;
      const threshold = current.get(id)?.threshold;
      return typeof threshold === "number" && threshold < NEVER_EMIT_THRESHOLD;
    };
    return {
      roster,
      lanes,
      current,
      champion,
      defaultModel: resolveDefaultModel(
        champion?.contestant ?? null,
        canCall,
        defaultContestant(consensusEnabled ? current.get(CONSENSUS_CONTESTANT)?.threshold : null),
      ),
    };
  });
}

/**
 * The ledger a feed request reads: an explicit `?model=`, else the user's saved pick, else the
 * default. A saved pick that has since left the roster (disabled, or renamed away) falls back to
 * the default rather than showing an empty feed.
 */
export function resolveFeedModel(
  state: ContestState,
  requested: string | undefined,
  saved: string | null,
): string {
  const enabled = (id: string | null | undefined): id is string =>
    typeof id === "string" && state.roster.some((c) => c.id === id);
  if (enabled(requested)) return requested;
  if (enabled(saved)) return saved;
  return state.defaultModel;
}

/** What a user saved about their feed: the User columns the feeds read. */
export interface SavedFeed {
  /** The single-ledger pick (/curated); kept equal to models[0]. */
  model: string | null;
  /** The combined feed's checked models; empty = follow the default. */
  models: string[];
  showModelAlerts: boolean;
  /** Follow the best performer (the default) instead of the hand picks above. */
  followBest: boolean;
}

export const SAVED_FEED_SELECT = {
  curatedModel: true,
  feedModels: true,
  showModelAlerts: true,
  followBestModel: true,
} as const;

export function toSavedFeed(user: {
  curatedModel: string | null;
  feedModels: string[];
  showModelAlerts: boolean;
  followBestModel: boolean;
}): SavedFeed {
  return {
    model: user.curatedModel,
    models: user.feedModels,
    showModelAlerts: user.showModelAlerts,
    followBest: user.followBestModel,
  };
}

const DEFAULT_SAVED_FEED: SavedFeed = { model: null, models: [], showModelAlerts: true, followBest: true };

export async function savedFeed(request: FastifyRequest): Promise<SavedFeed> {
  // The auth hook already read it for browser sessions; only device sessions pay for a lookup.
  if (request.savedFeed !== undefined) return request.savedFeed;
  const userId = request.user!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: SAVED_FEED_SELECT });
  return user ? toSavedFeed(user) : DEFAULT_SAVED_FEED;
}

/** The single-ledger pick a /curated request falls back to: none while following the best. */
export async function savedFeedModel(request: FastifyRequest): Promise<string | null> {
  const saved = await savedFeed(request);
  return saved.followBest ? null : saved.model;
}

/**
 * The ledgers the combined feed reads - the rule lives in core (curation/feedModels.ts), shared
 * with the worker's Telegram dispatcher so both decide "is this call in this person's feed" the
 * same way. `followsDefault` is true when the feed is showing the default.
 */
export function resolveFeedModels(
  state: ContestState,
  saved: Pick<SavedFeed, "model" | "models"> & Partial<SavedFeed>,
): { models: string[]; followsDefault: boolean } {
  return resolveFeedModelsShared(state, {
    model: saved.model,
    models: saved.models,
    followBest: saved.followBest === true,
  });
}

/** The display block a feed response carries for the model it is showing. */
export function modelLabel(state: ContestState, id: string) {
  const spec = state.roster.find((c) => c.id === id);
  return { id, name: spec?.name ?? id };
}

export interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  description: string;
  /** The same in plain words, for the Models tab's front leaderboard. */
  summary: string;
  role: ContestantSpec["role"];
  isDefault: boolean;
  /**
   * calling: it has a cutoff and can send. silent: trained, but its exam had nothing to set a
   * cutoff from, so it sends nothing this generation. untrained: no training run has produced it
   * yet (the rules contestant is never untrained - it calls on its gate alone).
   */
  status: "calling" | "silent" | "untrained";
  composite: CompositeScore;
  /** The score in a sentence: what it proves, from how much evidence, and the points. */
  scoreExplained: string;
  /** Its live record on high-conviction calls alone (CuratedAlert.tier = "high"); null with none graded. */
  highConviction: RecordSummary | null;
  /** Evolving seats only: the recipe holding the seat now, and where it came from. */
  lane: { generation: number; parentName: string | null; bornAt: Date } | null;
  /**
   * The Rules seat only: the checks it runs now - hand-tuned, or learned from the best model -
   * and the last training run's reason. Null for other seats and before a run has recorded it.
   */
  rules: {
    source: "hand-tuned" | "learned";
    lines: string[];
    teacherName: string | null;
    derivedAt: string | null;
    agreementPct: number | null;
    reason: string;
  } | null;
  model: {
    id: string;
    trainedAt: Date;
    trainingRows: number;
    /** Whether its cutoff met both hit-rate targets in its exam (else it calls at its best effort). */
    cutoffMeetsTargets: boolean | null;
    /** How many recent out-of-sample calls its calibration table rests on (0 = none). */
    calibrationCalls: number;
  } | null;
}

export interface Leaderboard {
  window: { days: number; since: Date };
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  scoring: {
    weights: typeof COMPOSITE_WEIGHTS;
    /** Run-size target, in doublings per call (2 = a 4x average). */
    runTargetDoublings: number;
    /** The 10x-within-an-hour rate target, in percent. */
    tenXTargetPct: number;
    /** Calls' worth of evidence the backtest counts for at most; live weighs the same at this many graded calls. */
    livePivotCalls: number;
    /** Calls counted as misses on top of every record, so a short streak can't prove a high rate. */
    priorCalls: number;
    /** Graded live calls a contestant needs before it is ranked on its score. */
    minLiveCallsToRank: number;
    /** The plain-language bands a score falls in, highest first. */
    bands: typeof SCORE_BANDS;
    summary: string;
  };
  /** The fixed exit plan the simulated returns on the board are worked out under, in a sentence. */
  exitPlan: string;
  defaultModel: string;
  /** When and why the default was last (re-)chosen; null before the first pick. */
  champion: {
    id: string;
    name: string;
    score: number | null;
    liveGraded: number;
    reason: string;
    chosenAt: Date;
    /** Graded live calls a model needs before it can hold the default. */
    minLiveGraded: number;
    /** Points a challenger must lead the sitting default by. */
    margin: number;
  } | null;
  entries: LeaderboardEntry[];
  evolution: {
    challengersPerRun: number;
    minAgeHours: number;
    margin: number;
    runEveryHours: number;
    /** Hours a winning challenger waits for fresh calls before it takes the seat (0 = none). */
    probationHours: number;
    /** The challenger waiting on probation, if any. */
    probation: { slot: string; name: string; seatName: string; startedAt: Date } | null;
    /** Recent takeovers and founding seats, newest first. */
    history: EvolutionEvent[];
  };
}

export interface EvolutionEvent {
  slot: string;
  name: string;
  description: string;
  generation: number;
  parentName: string | null;
  examScore: number | null;
  bornAt: Date;
  retiredAt: Date | null;
  retiredReason: string | null;
}

const EVOLUTION_HISTORY_LIMIT = 20;

export async function buildLeaderboard(env: Env, days: number): Promise<Leaderboard> {
  const since = new Date(Date.now() - days * 86_400_000);
  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  const state = await contestState(env);
  const [live, liveHigh, history, probation] = await Promise.all([
    liveCallRecords(
      state.roster.map((c) => c.id),
      since,
      state.lanes,
    ),
    liveCallRecords(
      state.roster.map((c) => c.id),
      since,
      state.lanes,
      { tier: "high" },
    ),
    prisma.curatorLane.findMany({
      orderBy: { bornAt: "desc" },
      take: EVOLUTION_HISTORY_LIMIT,
      select: {
        slot: true,
        name: true,
        description: true,
        generation: true,
        parentName: true,
        examScore: true,
        bornAt: true,
        retiredAt: true,
        retiredReason: true,
      },
    }),
    prisma.curatorProbation.findFirst({
      where: { resolvedAt: null },
      orderBy: { startedAt: "desc" },
      select: { slot: true, name: true, laneName: true, startedAt: true },
    }),
  ]);
  const laneBySlot = new Map(state.lanes.map((l) => [l.slot, l]));

  const unranked = state.roster.map((spec) => {
    const model = state.current.get(spec.id) ?? null;
    const exam = model?.metrics.exam ?? emptyRecord();
    const composite = compositeScore(live.get(spec.id) ?? emptyRecord(), exam, targets);
    const status: LeaderboardEntry["status"] =
      spec.role === "rules"
        ? "calling"
        : model === null
          ? "untrained"
          : model.threshold !== null && model.threshold < NEVER_EMIT_THRESHOLD
            ? "calling"
            : "silent";
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      summary: spec.summary ?? spec.description,
      role: spec.role,
      isDefault: spec.id === state.defaultModel,
      status,
      composite,
      scoreExplained: explainScore(composite, targets),
      highConviction: (() => {
        const record = liveHigh.get(spec.id);
        return record && record.graded > 0 ? summarizeRecord(record, targets) : null;
      })(),
      lane: (() => {
        const lane = laneBySlot.get(spec.id);
        return lane
          ? { generation: lane.generation, parentName: lane.parentName, bornAt: lane.bornAt }
          : null;
      })(),
      rules: (() => {
        const r = spec.role === "rules" ? model?.metrics.rulesInUse : undefined;
        return r
          ? {
              source: r.source,
              lines: r.lines,
              teacherName: r.teacher?.name ?? null,
              derivedAt: r.derivedAt ?? null,
              agreementPct: r.agreementPct ?? null,
              reason: r.reason,
            }
          : null;
      })(),
      model: model
        ? {
            id: model.id,
            trainedAt: model.trainedAt,
            trainingRows: model.trainingRows,
            cutoffMeetsTargets: model.metrics.precisionCalibration?.meetsTargets ?? null,
            calibrationCalls: model.metrics.calibrationCalls ?? 0,
          }
        : null,
    };
  });

  return {
    window: { days, since },
    targets: {
      hitRate2xPct: env.CURATED_TARGET_WIN_RATE_PCT,
      hitRate4xPct: env.CURATED_TARGET_GOAL_RATE_PCT,
    },
    scoring: {
      weights: COMPOSITE_WEIGHTS,
      runTargetDoublings: RUN_SIZE_TARGET_DOUBLINGS,
      tenXTargetPct: TEN_X_TARGET_RATE * 100,
      livePivotCalls: BACKTEST_EVIDENCE_CAP,
      priorCalls: PRIOR_CALLS,
      minLiveCallsToRank: MIN_LIVE_CALLS_TO_RANK,
      bands: SCORE_BANDS,
      summary:
        `The score is how far a model has proven itself toward the goal, 0-100: ${Math.round(COMPOSITE_WEIGHTS.winRate * 100)} points ` +
        `for its 2x rate against ${env.CURATED_TARGET_WIN_RATE_PCT}%, ${Math.round(COMPOSITE_WEIGHTS.goalRate * 100)} for its 4x rate against ` +
        `${env.CURATED_TARGET_GOAL_RATE_PCT}%, ${Math.round(COMPOSITE_WEIGHTS.tenXRate * 100)} for its rate of 10x within an hour against ` +
        `${TEN_X_TARGET_RATE * 100}%, and ${Math.round(COMPOSITE_WEIGHTS.runSize * 100)} for run size: how far its calls ran over 24h, ` +
        `in doublings per call, against ${RUN_SIZE_TARGET_DOUBLINGS} (a ${2 ** RUN_SIZE_TARGET_DOUBLINGS}x average). Rates and run size are proven, not raw: ${PRIOR_CALLS} extra calls count as misses, so a short streak ` +
        `can't score like a long record. The backtest counts for at most ${BACKTEST_EVIDENCE_CAP} calls' worth; live calls take over from there. ` +
        `Models with fewer than ${MIN_LIVE_CALLS_TO_RANK} graded live calls are still warming up and rank below the rest.`,
    },
    exitPlan: describeExitPlan(),
    defaultModel: state.defaultModel,
    champion:
      state.champion && state.champion.contestant === state.defaultModel
        ? {
            id: state.champion.contestant,
            name: state.roster.find((c) => c.id === state.champion!.contestant)?.name ?? state.champion.name,
            score: state.champion.score,
            liveGraded: state.champion.liveGraded,
            reason: state.champion.reason,
            chosenAt: state.champion.chosenAt,
            minLiveGraded: env.CURATOR_CHAMPION_MIN_LIVE_GRADED,
            margin: env.CURATOR_CHAMPION_MARGIN,
          }
        : null,
    entries: rankByComposite(unranked).map((entry, i) => ({ rank: i + 1, ...entry })),
    evolution: {
      challengersPerRun: env.CURATOR_EVOLUTION_CHALLENGERS,
      minAgeHours: env.CURATOR_EVOLUTION_MIN_AGE_HOURS,
      margin: env.CURATOR_EVOLUTION_MARGIN,
      runEveryHours: env.CURATOR_TRAINING_INTERVAL_HOURS,
      probationHours: env.CURATOR_EVOLUTION_PROBATION_HOURS,
      probation: probation
        ? {
            slot: probation.slot,
            name: probation.name,
            seatName: probation.laneName,
            startedAt: probation.startedAt,
          }
        : null,
      history,
    },
  };
}
