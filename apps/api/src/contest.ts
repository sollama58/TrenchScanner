import {
  prisma,
  compositeScore,
  defaultContestant,
  loadChampion,
  loadTopModels,
  resolveDefaultModel,
  resolveDefaultModels,
  resetTopModelsCache,
  TOP_MODELS_COUNT,
  TOP_MODELS_MIN_GRADED,
  TOP_MODELS_REFRESH_MINUTES,
  TOP_MODELS_WINDOW_HOURS,
  topModelsWindow,
  CURRENT_LABEL_RULE,
  TOP_MODELS_RANK_WINDOW_HOURS,
  TOP_MODELS_RANK_MIN_GRADED,
  sittingOutCombiners,
  resolveFeedModels as resolveFeedModelsShared,
  emptyRecord,
  enabledContestants,
  liveCallRecords,
  liveMarketLift,
  liveCatchRates,
  feedCatch,
  mixCatch,
  loadCurrentLanes,
  rankByMarketLift,
  withLanes,
  CONSENSUS_CONTESTANT,
  BACKTEST_EVIDENCE_CAP,
  MIN_LIVE_CALLS_TO_RANK,
  CATCH_TARGET_RATE,
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
  type Last24h,
  type MarketLift,
  type AddCandidate,
  type CatchLedger,
  type LiveCatch,
  type FeedCatch,
  type MixCoverage,
  type RecordSummary,
  type ContestantSpec,
  type Env,
  type Lane,
  type PrecisionTargets,
  type StoredEvalMetrics,
} from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";
import { baselineRates, type GradedRates } from "./routes/stats.js";
import type { MarketRowSource } from "./marketRows.js";
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
  /** The single best performer: the champion while it can call, else the fallback. */
  defaultModel: string;
  /**
   * Whose calls a user who hasn't picked (and a guest) sees: the top models by 2x lower bound
   * (core curation/topModels.ts), best first; [defaultModel] while too few qualify.
   */
  defaultModels: string[];
  /** The best average exit-plan return over the last 24h (core curation/topModels.ts); null when none qualify. */
  bestModel: string | null;
  /** Each model's record over the same 24h window. */
  last24h: Map<string, Last24h>;
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
  resetTopModelsCache();
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
    const sittingOut = await sittingOutCombiners(roster);
    const canCall = (id: string) => {
      const spec = roster.find((c) => c.id === id);
      if (!spec) return false;
      if (spec.role === "rules") return true;
      if (sittingOut.has(id)) return false;
      const threshold = current.get(id)?.threshold;
      return typeof threshold === "number" && threshold < NEVER_EMIT_THRESHOLD;
    };
    const defaultModel = resolveDefaultModel(
      champion?.contestant ?? null,
      canCall,
      defaultContestant(consensusEnabled ? current.get(CONSENSUS_CONTESTANT)?.threshold : null),
    );
    const { top, best, last24h } = await loadTopModels(roster, lanes, canCall);
    return {
      roster,
      lanes,
      current,
      champion,
      defaultModel,
      defaultModels: resolveDefaultModels(top, defaultModel, champion?.contestant ?? null),
      bestModel: best,
      last24h,
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
  /**
   * Only alerts both caught: the feed keeps only its filter alerts on tokens a followed model also
   * called. Saved as is; whether it applies (model alerts on) is feedBothOnlyApplies' call.
   */
  bothOnly: boolean;
}

export const SAVED_FEED_SELECT = {
  curatedModel: true,
  feedModels: true,
  showModelAlerts: true,
  followBestModel: true,
  feedBothOnly: true,
} as const;

export function toSavedFeed(user: {
  curatedModel: string | null;
  feedModels: string[];
  showModelAlerts: boolean;
  followBestModel: boolean;
  feedBothOnly: boolean;
}): SavedFeed {
  return {
    model: user.curatedModel,
    models: user.feedModels,
    showModelAlerts: user.showModelAlerts,
    followBest: user.followBestModel,
    bothOnly: user.feedBothOnly,
  };
}

/** Whether a saved feed is narrowed to alerts both caught: the switch is on and model alerts are too. */
export function feedBothOnlyApplies(saved: Pick<SavedFeed, "showModelAlerts" | "bothOnly">): boolean {
  return saved.showModelAlerts && saved.bothOnly;
}

const DEFAULT_SAVED_FEED: SavedFeed = {
  model: null,
  models: [],
  showModelAlerts: true,
  followBest: true,
  bothOnly: false,
};

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
  /** In the default feed: one of the top models by 24h 2x hit rate. */
  isDefault: boolean;
  /** The best average exit-plan return over the last 24h (the "best" marker). */
  isBest: boolean;
  /** Its record over the default rule's 24h window (the Live tab's model dropdown). */
  last24h: Last24h | null;
  /**
   * calling: it has a cutoff and can send. silent: trained, but its exam had nothing to set a
   * cutoff from, so it sends nothing this generation. untrained: no training run has produced it
   * yet (the rules contestant is never untrained - it calls on its gate alone).
   */
  status: "calling" | "silent" | "untrained";
  composite: CompositeScore;
  /** Its live 2x rate against the market's in the hours it called; null with no graded calls. */
  vsMarket: MarketLift | null;
  /**
   * Of the tokens that ran (a clean 2x from a graded market moment or any seat's call) since its
   * own start in the window, how many it called at a winning moment: the live catch rate.
   */
  liveCatch: LiveCatch | null;
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
  /**
   * The random-pick baseline over the same window: every "event" moment the models choose from,
   * on the same market definition as `lifts` (baselineRates).
   */
  baseline: GradedRates;
  /** The runners over the window and how many any seat caught: the ones the whole board let slip. */
  runners: LiveCatch;
  /**
   * What the catch rates were counted from, so a reader's own mix can be scored (readerBoard). Names
   * tokens, so it never leaves the process: readerBoard drops it.
   */
  catchLedger: CatchLedger;
  scoring: {
    weights: typeof COMPOSITE_WEIGHTS;
    /** Run-size target, in doublings per call (2 = a 4x average). */
    runTargetDoublings: number;
    /** The 10x-within-an-hour rate target, in percent. */
    tenXTargetPct: number;
    /** The catch-rate target: share of the backtest's runners called, in percent. */
    catchTargetPct: number;
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
  /** The default feed's models, best first, and the rule that picks them. */
  defaultModels: string[];
  /** The best average exit-plan return over the default rule's window; null when none qualify. */
  bestModel: string | null;
  /**
   * The default feed's rule: the top `count` models by 2x Wilson lower bound (at
   * rankConfidencePct) over the last rankWindowHours, among those with rankMinGraded graded calls
   * there, re-picked every refreshMinutes. windowHours and minGraded are the 24h records' window
   * and floor (the dropdown's ranking and "best").
   */
  defaultRule: {
    count: number;
    windowHours: number;
    minGraded: number;
    refreshMinutes: number;
    rankedBy: "2x-lower-bound";
    rankWindowHours: number;
    rankMinGraded: number;
    rankConfidencePct: number;
    /** The 24h window the current slot's top models and "best" were read on (topModelsWindow). */
    window: { since: Date; until: Date };
  };
  /**
   * The default feed's own pooled record over the board's window: every call the stored top-model
   * picks (TopModelsPick) delivered while they held their slot, each token once. Null when no slot
   * in the window had a stored pick.
   */
  defaultFeed: DefaultFeedRecord | null;
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

/** What the default feed (the stored top-model picks, slot by slot) delivered over a window. */
export interface DefaultFeedRecord {
  /** The first slot in the window with a stored pick: later than the window's start on a young record. */
  since: Date;
  /** Calls, each token once (its first call while a picked model held the slot). */
  calls: number;
  /** Graded and clean 2x wins, on the alert's own grade (rule 3 and up, as the board's records). */
  graded: number;
  wins: number;
  /** The same on rule-4 rows alone (CURRENT_LABEL_RULE: the alert priced from a fresh quote). */
  gradedRule4: number;
  winsRule4: number;
  /** Slots in the window whose stored pick was empty (too few models qualified; the single champion fed). */
  fallbackSlots: number;
}

/**
 * The default feed's pooled record since `since`: for each 6-hour slot's stored pick, plus the
 * champion the feed adds while it holds the title, the calls its models made inside that slot,
 * first call per token, graded as the leaderboard grades a call (the
 * alert's own verdict, else its outcome row's) and, separately, on rule-4 outcome rows alone.
 */
export async function defaultFeedRecord(
  since: Date,
  now: Date = new Date(),
): Promise<DefaultFeedRecord | null> {
  const slotMs = TOP_MODELS_REFRESH_MINUTES * 60_000;
  const firstSlot = new Date(Math.floor(since.getTime() / slotMs) * slotMs);
  const rows = await prisma.$queryRaw<
    {
      covered_from: Date | null;
      fallback_slots: bigint;
      calls: bigint;
      graded: bigint;
      wins: bigint;
      graded4: bigint;
      wins4: bigint;
    }[]
  >`
    WITH slots AS (
      SELECT p."slotStart" AS slot_start, p."models" AS models
      FROM "TopModelsPick" p
      WHERE p."slotStart" >= ${firstSlot} AND p."slotStart" <= ${now}
    ),
    picked AS (
      SELECT slot_start, slot_start + make_interval(mins => ${TOP_MODELS_REFRESH_MINUTES}::int) AS slot_end, models
      FROM slots
      WHERE cardinality(models) > 0
    ),
    champions AS (
      SELECT "contestant" AS model, "chosenAt" AS held_from,
             COALESCE(lead("chosenAt") OVER (ORDER BY "chosenAt"), 'infinity'::timestamp) AS held_to
      FROM "CuratorChampion"
    ),
    picks AS (
      SELECT slot_start, slot_end, unnest(models) AS model
      FROM picked
      UNION ALL
      -- The champion joins the served feed when it is not in the pick (resolveDefaultModels), for
      -- the part of the slot it held the title. A token called by both counts once (calls below).
      SELECT GREATEST(p.slot_start, c.held_from), LEAST(p.slot_end, c.held_to), c.model
      FROM picked p
      JOIN champions c ON c.held_from < p.slot_end AND c.held_to > p.slot_start
      WHERE NOT (c.model = ANY(p.models))
    ),
    calls AS (
      SELECT DISTINCT ON (a."tokenId")
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             co."labelRule" AS rule,
             co."hit2xIn1h" AS row_hit2x,
             COALESCE(co."disqualified", false) AS row_dq
      FROM "CuratedAlert" a
      JOIN picks ON picks.model = a."model"
        AND a."createdAt" >= picks.slot_start AND a."createdAt" < picks.slot_end
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${since}
      ORDER BY a."tokenId", a."createdAt"
    )
    SELECT (SELECT min(slot_start) FROM slots WHERE cardinality(models) > 0) AS covered_from,
           (SELECT count(*) FROM slots WHERE cardinality(models) = 0) AS fallback_slots,
           count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE rule >= ${CURRENT_LABEL_RULE} AND row_hit2x IS NOT NULL) AS graded4,
           count(*) FILTER (WHERE rule >= ${CURRENT_LABEL_RULE} AND row_hit2x AND NOT row_dq) AS wins4
    FROM calls`;
  const r = rows[0];
  if (!r?.covered_from) return null;
  return {
    since: r.covered_from > since ? r.covered_from : since,
    calls: Number(r.calls),
    graded: Number(r.graded),
    wins: Number(r.wins),
    gradedRule4: Number(r.graded4),
    winsRule4: Number(r.wins4),
    fallbackSlots: Number(r.fallback_slots),
  };
}

/**
 * The clean 2x alerts of a reader's switched-on filters since `since`, by token at its latest such
 * alert: what their filters add to the feed's catch (feedCatch).
 */
export async function filterWins(
  userId: string,
  since: Date,
): Promise<{ count: number; wins: { token: string; at: Date }[]; since: Date }> {
  const filters = await prisma.userFilter.findMany({
    where: { userId, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (filters.length === 0) return { count: 0, wins: [], since };
  const wins = await prisma.$queryRaw<{ token: string; at: Date }[]>`
    SELECT "tokenId" AS token, max("matchedAt") AS at
    FROM "Match"
    WHERE "userId" = ${userId} AND "matchedAt" >= ${since}
      AND "filterId" = ANY(${filters.map((f) => f.id)})
      AND "hit2xIn1h" AND NOT COALESCE("disqualified", false)
    GROUP BY 1`;
  return { count: filters.length, wins, since };
}

/**
 * The board as one reader sees it: without the catch ledger, and with the Coverage Meter for the
 * models their feed shows - the share of the window's runners those models would have caught
 * together (mixCatch) - and, given their filters' wins (filterWins), the whole feed's catch with
 * their filters added (feedCatch). `feedModels` is the models whose calls the feed actually
 * shows: none while model alerts are off.
 */
export function readerBoard(
  board: Leaderboard,
  models: readonly string[],
  feed?: {
    models: readonly string[];
    filters: Awaited<ReturnType<typeof filterWins>>;
    /** Only alerts both caught: a runner counts when a model and a filter both caught it. */
    bothOnly?: boolean;
  },
): Omit<Leaderboard, "catchLedger"> & { coverage: MixCoverage; feedCatch?: FeedCatch } {
  const { catchLedger, ...rest } = board;
  // What the meter weighs before suggesting a model: its live record over the same window. A
  // silent or untrained model sends nothing, so it can't be "added" in any useful sense.
  const candidates = new Map<string, AddCandidate>(
    board.entries.map((e) => [
      e.id,
      {
        seasoned: e.status === "calling" && !e.composite.warmingUp,
        calls: e.composite.live.calls,
        winRatePct:
          e.composite.live.winRatePct === null ? null : Math.round(e.composite.live.winRatePct * 10) / 10,
        lift: e.vsMarket?.lift ?? null,
        avgReturnPct: e.composite.live.avgSimReturnPct,
      },
    ]),
  );
  return {
    ...rest,
    coverage: mixCatch(catchLedger, models, candidates),
    ...(feed ? { feedCatch: feedCatch(catchLedger, feed.models, feed.filters, feed.bothOnly ?? false) } : {}),
  };
}

export async function buildLeaderboard(
  env: Env,
  days: number,
  /** Shared market rows (marketRows.ts); without them, or past their span, the market is read here. */
  market?: MarketRowSource,
): Promise<Leaderboard> {
  const since = new Date(Date.now() - days * 86_400_000);
  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  const [state, marketRows] = await Promise.all([contestState(env), market ? market(since) : null]);
  const [live, liveHigh, history, probation, lifts, baseline, catches, defaultFeed] = await Promise.all([
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
    liveMarketLift(
      state.roster.map((c) => c.id),
      since,
      state.lanes,
      marketRows ?? undefined,
    ),
    baselineRates(
      since,
      {
        hitRate2xPct: env.CURATED_TARGET_WIN_RATE_PCT,
        hitRate4xPct: env.CURATED_TARGET_GOAL_RATE_PCT,
      },
      undefined,
      marketRows,
    ),
    liveCatchRates(
      state.roster.map((c) => c.id),
      since,
      state.lanes,
      marketRows ?? undefined,
    ),
    // Informational: a failed read leaves the headline on the board's own figures.
    defaultFeedRecord(since).catch((): DefaultFeedRecord | null => null),
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
      isDefault: state.defaultModels.includes(spec.id),
      isBest: spec.id === state.bestModel,
      last24h: state.last24h.get(spec.id) ?? null,
      status,
      composite,
      vsMarket: lifts.get(spec.id) ?? null,
      liveCatch: catches.byModel.get(spec.id) ?? null,
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
    baseline,
    runners: catches.field,
    catchLedger: catches.ledger,
    scoring: {
      weights: COMPOSITE_WEIGHTS,
      runTargetDoublings: RUN_SIZE_TARGET_DOUBLINGS,
      tenXTargetPct: TEN_X_TARGET_RATE * 100,
      catchTargetPct: CATCH_TARGET_RATE * 100,
      livePivotCalls: BACKTEST_EVIDENCE_CAP,
      priorCalls: PRIOR_CALLS,
      minLiveCallsToRank: MIN_LIVE_CALLS_TO_RANK,
      bands: SCORE_BANDS,
      summary:
        `The score is how far a model has proven itself toward the goal, 0-100: ${Math.round(COMPOSITE_WEIGHTS.winRate * 100)} points ` +
        `for its 2x rate against ${env.CURATED_TARGET_WIN_RATE_PCT}%, ${Math.round(COMPOSITE_WEIGHTS.goalRate * 100)} for its 4x rate against ` +
        `${env.CURATED_TARGET_GOAL_RATE_PCT}%, ${Math.round(COMPOSITE_WEIGHTS.tenXRate * 100)} for its rate of 10x within an hour against ` +
        `${TEN_X_TARGET_RATE * 100}%, ${Math.round(COMPOSITE_WEIGHTS.runSize * 100)} for run size: how far its calls ran over 24h, ` +
        `in doublings per call, against ${RUN_SIZE_TARGET_DOUBLINGS} (a ${2 ** RUN_SIZE_TARGET_DOUBLINGS}x average), and ${Math.round(COMPOSITE_WEIGHTS.catchRate * 100)} for catching runners: ` +
        `the share of the tokens that doubled in its backtest that it called, against ${CATCH_TARGET_RATE * 100}%. ` +
        `Rates and run size are proven, not raw: ${PRIOR_CALLS} extra calls count as misses, so a short streak ` +
        `can't score like a long record. The backtest counts for at most ${BACKTEST_EVIDENCE_CAP} calls' worth; live calls take over from there. ` +
        `Models with fewer than ${MIN_LIVE_CALLS_TO_RANK} graded live calls are still warming up and rank below the rest.`,
    },
    exitPlan: describeExitPlan(),
    defaultModel: state.defaultModel,
    defaultModels: state.defaultModels,
    bestModel: state.bestModel,
    defaultRule: {
      count: TOP_MODELS_COUNT,
      windowHours: TOP_MODELS_WINDOW_HOURS,
      minGraded: TOP_MODELS_MIN_GRADED,
      refreshMinutes: TOP_MODELS_REFRESH_MINUTES,
      rankedBy: "2x-lower-bound" as const,
      rankWindowHours: TOP_MODELS_RANK_WINDOW_HOURS,
      rankMinGraded: TOP_MODELS_RANK_MIN_GRADED,
      rankConfidencePct: 95,
      window: (({ since: from, until }) => ({ since: from, until }))(topModelsWindow(new Date())),
    },
    defaultFeed,
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
    entries: rankByMarketLift(unranked).map((entry, i) => ({ rank: i + 1, ...entry })),
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
