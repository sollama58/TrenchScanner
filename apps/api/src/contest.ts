import {
  prisma,
  compositeScore,
  defaultContestant,
  emptyRecord,
  enabledContestants,
  liveCallRecords,
  loadCurrentLanes,
  rankByComposite,
  withLanes,
  CONSENSUS_CONTESTANT,
  LIVE_EVIDENCE_PIVOT,
  COMPOSITE_WEIGHTS,
  NEVER_EMIT_THRESHOLD,
  type CompositeScore,
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
  /** Whose calls a user who hasn't picked sees. */
  defaultModel: string;
}

const stateCache = new SharedCache<ContestState>(STATE_CACHE_TTL_MS);

/** Test hook. */
export function resetContestStateCache(): void {
  stateCache.clear();
}

export function contestState(env: Env): Promise<ContestState> {
  return stateCache.get(async () => {
    const lanes = await loadCurrentLanes();
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
    return {
      roster,
      lanes,
      current,
      defaultModel: defaultContestant(consensusEnabled ? current.get(CONSENSUS_CONTESTANT)?.threshold : null),
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

export async function savedFeedModel(request: FastifyRequest): Promise<string | null> {
  // The auth hook already read it for browser sessions; only device sessions pay for a lookup.
  if (request.savedFeedModel !== undefined) return request.savedFeedModel;
  const userId = request.user!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { curatedModel: true } });
  return user?.curatedModel ?? null;
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
  /** Evolving seats only: the recipe holding the seat now, and where it came from. */
  lane: { generation: number; parentName: string | null; bornAt: Date } | null;
  model: {
    id: string;
    trainedAt: Date;
    trainingRows: number;
    /** Whether its cutoff met both hit-rate targets in its exam (else it calls at its best effort). */
    cutoffMeetsTargets: boolean | null;
  } | null;
}

export interface Leaderboard {
  window: { days: number; since: Date };
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  scoring: {
    weights: typeof COMPOSITE_WEIGHTS;
    livePivotCalls: number;
    summary: string;
  };
  defaultModel: string;
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
  const [live, history] = await Promise.all([
    liveCallRecords(
      state.roster.map((c) => c.id),
      since,
      state.lanes,
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
      summary:
        "0-100: 45% the 2x hit rate vs target, 30% the 4x rate vs target (both as lower confidence bounds), " +
        `25% average return per call. Blends the backtest with live calls; live counts half at ${LIVE_EVIDENCE_PIVOT} graded calls.`,
    },
    defaultModel: state.defaultModel,
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
