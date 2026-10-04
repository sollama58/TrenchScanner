import {
  prisma,
  compositeScore,
  defaultContestant,
  loadChampion,
  resolveDefaultModel,
  emptyRecord,
  enabledContestants,
  liveCallRecords,
  loadCurrentLanes,
  rankByComposite,
  withLanes,
  CONSENSUS_CONTESTANT,
  LIVE_EVIDENCE_PIVOT,
  MIN_LIVE_CALLS_TO_RANK,
  COMPOSITE_WEIGHTS,
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
 * The ledgers the combined feed reads, in roster order: the default (the best performer) while the
 * user follows it; else their checked models that are still on the roster, else their single
 * pick, else the default. `followsDefault` is true when the feed is showing the default.
 */
export function resolveFeedModels(
  state: ContestState,
  saved: Pick<SavedFeed, "model" | "models"> & Partial<SavedFeed>,
): { models: string[]; followsDefault: boolean } {
  if (saved.followBest) return { models: [state.defaultModel], followsDefault: true };
  const checked = new Set(saved.models);
  const models = state.roster.filter((c) => checked.has(c.id)).map((c) => c.id);
  if (models.length > 0) return { models, followsDefault: false };
  const single = resolveFeedModel(state, undefined, saved.model);
  return { models: [single], followsDefault: single !== saved.model };
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
  role: ContestantSpec["role"];
  isDefault: boolean;
  /**
   * calling: it has a cutoff and can send. silent: trained, but its exam had nothing to set a
   * cutoff from, so it sends nothing this generation. untrained: no training run has produced it
   * yet (the rules contestant is never untrained - it calls on its gate alone).
   */
  status: "calling" | "silent" | "untrained";
  composite: CompositeScore;
  /** Its live record on high-conviction calls alone (CuratedAlert.tier = "high"); null with none graded. */
  highConviction: RecordSummary | null;
  /** Evolving seats only: the recipe holding the seat now, and where it came from. */
  lane: { generation: number; parentName: string | null; bornAt: Date } | null;
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
    livePivotCalls: number;
    /** Graded live calls a contestant needs before it is ranked on its score. */
    minLiveCallsToRank: number;
    summary: string;
  };
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
  const [live, liveHigh, history] = await Promise.all([
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
  ]);
  const laneBySlot = new Map(state.lanes.map((l) => [l.slot, l]));

  const unranked = state.roster.map((spec) => {
    const model = state.current.get(spec.id) ?? null;
    const exam = model?.metrics.exam ?? emptyRecord();
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
      role: spec.role,
      isDefault: spec.id === state.defaultModel,
      status,
      composite: compositeScore(live.get(spec.id) ?? emptyRecord(), exam, targets),
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
      livePivotCalls: LIVE_EVIDENCE_PIVOT,
      minLiveCallsToRank: MIN_LIVE_CALLS_TO_RANK,
      summary:
        "0-100: 45% the 2x hit rate vs target, 30% the 4x rate vs target (both as lower confidence bounds), " +
        `25% average return per call. Blends the backtest with live calls; live counts half at ${LIVE_EVIDENCE_PIVOT} graded calls. ` +
        `Models with fewer than ${MIN_LIVE_CALLS_TO_RANK} graded live calls are still warming up and rank below the rest.`,
    },
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
      history,
    },
  };
}
