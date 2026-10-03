import {
  prisma,
  compositeScore,
  defaultContestant,
  emptyRecord,
  enabledContestants,
  rankByComposite,
  contestantSpec,
  CONSENSUS_CONTESTANT,
  LABEL_LOG2_CAP,
  LIVE_EVIDENCE_PIVOT,
  COMPOSITE_WEIGHTS,
  NEVER_EMIT_THRESHOLD,
  type CallRecord,
  type CompositeScore,
  type ContestantSpec,
  type Env,
  type PrecisionTargets,
  type StoredEvalMetrics,
} from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";

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
  /** The enabled roster, in canonical order. */
  roster: ContestantSpec[];
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
    const roster = enabledContestants(env.CURATOR_CONTESTANTS);
    const rows = await prisma.curatorModel.findMany({
      where: { status: "active", contestant: { in: roster.map((c) => c.id) } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        contestant: true,
        kind: true,
        createdAt: true,
        trainingRows: true,
        params: true,
        evalMetrics: true,
      },
    });
    const current = new Map<string, ContestantModel>();
    for (const row of rows) {
      if (!row.contestant || current.has(row.contestant)) continue;
      const threshold = (row.params as { threshold?: unknown } | null)?.threshold;
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

export async function savedFeedModel(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { curatedModel: true } });
  return user?.curatedModel ?? null;
}

/** The display block a feed response carries for the model it is showing. */
export function modelLabel(id: string) {
  const spec = contestantSpec(id);
  return { id, name: spec?.name ?? id };
}

interface LiveRow {
  model: string;
  calls: bigint;
  graded: bigint;
  wins: bigint;
  goals: bigint;
  sum_label: number | null;
}

/**
 * Every contestant's live record over the window, graded exactly like the hit-rate report: the
 * alert's outcome copies when they've landed, else the linked training row. Returns in doublings
 * use the row's labelValue, or - once the row is pruned - the copied 1h peak, capped the same way.
 */
async function liveRecords(since: Date): Promise<Map<string, CallRecord>> {
  const rows = await prisma.$queryRaw<LiveRow[]>`
    WITH calls AS (
      SELECT a."model",
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             co."labelValue" AS label,
             a."peak1hReturnPct" AS peak
      FROM "CuratedAlert" a
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${since} AND a."model" IS NOT NULL
    )
    SELECT "model",
           count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE hit4x AND NOT dq) AS goals,
           sum(CASE WHEN hit2x AND NOT dq THEN
                 COALESCE(label, LEAST(log(2::numeric, GREATEST(1 + peak / 100, 1)::numeric)::float8, ${LABEL_LOG2_CAP}::float8))
               ELSE 0 END)::float8 AS sum_label
    FROM calls
    GROUP BY "model"`;
  return new Map(
    rows.map((r) => [
      r.model,
      {
        calls: Number(r.calls),
        graded: Number(r.graded),
        wins: Number(r.wins),
        goals: Number(r.goals),
        sumLabel: r.sum_label ?? 0,
      },
    ]),
  );
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
}

export async function buildLeaderboard(env: Env, days: number): Promise<Leaderboard> {
  const since = new Date(Date.now() - days * 86_400_000);
  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  const [state, live] = await Promise.all([contestState(env), liveRecords(since)]);

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
  };
}
