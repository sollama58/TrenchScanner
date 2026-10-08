import {
  type Env,
  type PrecisionTargets,
  prisma,
  recordScore,
  scoreBand,
  provenRate,
  TRACK_RECORD_DAYS,
  RUN_DOUBLINGS,
  RUN_SIZE_TARGET_DOUBLINGS,
  TEN_X_TARGET_RATE,
} from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";

/**
 * The public filter leaderboard: saved filters whose owners opted in (UserFilter.shareOnLeaderboard),
 * ranked by the same 0-100 score as the model contest (curation/leaderboard.ts: how far the
 * filter's PROVEN 2x and 4x rates reach toward the 75% / 50% targets, plus how far its calls ran
 * over their 24h watch, its run size), on its alerts' own verdicts - 2x within 15 minutes of the alert price, 4x within 30, a 50% drop first is a loss.
 *
 * A filter's record counts only alerts raised in the last TRACK_RECORD_DAYS AND since its criteria
 * last changed (criteriaChangedAt), so the record next to a filter is always the record of the
 * settings "Copy" hands out. Owners are never shown: entries carry the filter's name and a short
 * tag from its id, and `mine` is worked out per request, never stored in the shared board.
 */

/** Graded alerts a filter needs before it is ranked. Below this it is listed as warming up. */
export const MIN_GRADED_TO_RANK = 30;
/** Ranked entries returned. */
export const FILTER_LEADERBOARD_SIZE = 50;
/** Warming-up entries returned (most graded first). */
const WARMING_UP_SIZE = 20;
/**
 * A filter that ever ranked this high is kept, retired, when its owner deletes it (user decision
 * 2026-10-06): its alert history and record stay on the board instead of cascading away.
 */
export const KEEP_IF_EVER_RANKED_WITHIN = 3;

/**
 * The fields that decide what a filter matches - what "Copy" copies, and what resets the
 * leaderboard record when edited. Name, isActive and shareOnLeaderboard are not criteria.
 */
export const FILTER_CRITERIA_KEYS = [
  "mcapMin",
  "mcapMax",
  "minVolumeMcapRatio",
  "minHolderGrowthPct",
  "maxTop10HolderPct",
  "maxDevWalletPct",
  "maxRiskScore",
  "excludeCriticalRiskFlags",
  "minTokenAgeMinutes",
  "maxTokenAgeMinutes",
  "narrativeKeywords",
  "minScore",
  "maxFreshTop10WalletPct",
  "maxEmptyTop10WalletPct",
  "maxSniperTop10WalletPct",
  "minFirstBuyersHolding",
  "maxFirstBuyersHolding",
  "narrativeCategories",
  "excludeNarrativeCategories",
  "excludeCopycats",
  "excludeNarrativeRedFlags",
  "excludeUnrelatedX",
  "requireTrendMatch",
  "excludeLateCopies",
] as const;

export type FilterCriteriaKey = (typeof FILTER_CRITERIA_KEYS)[number];
export type FilterCriteria = { [K in FilterCriteriaKey]: unknown };

/** Whether `patch` changes any criterion of `existing` (a value sent unchanged doesn't count). */
export function criteriaChanged(existing: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return FILTER_CRITERIA_KEYS.some((k) => {
    if (!(k in patch) || patch[k] === undefined) return false;
    return JSON.stringify(patch[k] ?? null) !== JSON.stringify(existing[k] ?? null);
  });
}

export function pickCriteria(row: Record<string, unknown>): FilterCriteria {
  return Object.fromEntries(FILTER_CRITERIA_KEYS.map((k) => [k, row[k] ?? null])) as FilterCriteria;
}

export interface FilterLeaderboardEntry {
  id: string;
  /** The owner's name for the filter. */
  name: string;
  /** A short tag from the filter id, to tell apart two filters both called "New filter". */
  tag: string;
  /** 1-based; null while warming up. */
  rank: number | null;
  score: number | null;
  band: ReturnType<typeof scoreBand>;
  graded: number;
  won2x: number;
  won4x: number;
  /** Clean 10x within an hour of the alert (the third tier; shown, not scored). */
  won10x: number;
  winRatePct: number | null;
  goalRatePct: number | null;
  tenXRatePct: number | null;
  proven2xPct: number | null;
  proven4xPct: number | null;
  /** Average run size per graded alert, in doublings (the model score's run-size measure). */
  avgRunDoublings: number | null;
  /** The run size the record proves (with the score's phantom misses), in doublings. */
  provenRunDoublings: number | null;
  /** Where the record starts: the later of the window start and the last criteria change. */
  recordSince: string;
  /** Whether it is its owner's active filter now (only an active filter raises alerts). */
  isActive: boolean;
  /** Its owner deleted it; kept for its record (it once ranked in the top few). Never alerts again. */
  retired: boolean;
  criteria: FilterCriteria;
  /** The caller's own filter - set per request. */
  mine: boolean;
}

export interface FilterLeaderboard {
  generatedAt: string;
  windowDays: number;
  minGradedToRank: number;
  targets: { hitRate2xPct: number; hitRate4xPct: number; runDoublings: number; tenXPct: number };
  ranked: FilterLeaderboardEntry[];
  warmingUp: FilterLeaderboardEntry[];
  /** Every shared filter, ranked or not (the lists above are capped). */
  sharedCount: number;
}

/** The board as cached: entries keep their owner id, stripped before anything is sent. */
type CachedEntry = FilterLeaderboardEntry & { ownerId: string; bestRank: number | null };
interface CachedBoard extends Omit<FilterLeaderboard, "ranked" | "warmingUp"> {
  ranked: CachedEntry[];
  warmingUp: CachedEntry[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

type Row = {
  id: string;
  userId: string;
  name: string;
  isActive: boolean;
  deletedAt: Date | null;
  bestRank: number | null;
  criteriaChangedAt: Date;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  sum_run: number | null;
} & Record<FilterCriteriaKey, unknown>;

export async function buildFilterLeaderboard(env: Env, now = new Date()): Promise<CachedBoard> {
  const since = new Date(now.getTime() - TRACK_RECORD_DAYS * 86_400_000);
  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  // One pass over the shared filters' graded alerts, through Match's filterId index. Only graded
  // rows count (hit2xIn1h set); the verdicts are the ones copied from each alert's own anchor.
  // Run size is the model score's own measure (RUN_DOUBLINGS, curation/laneStore.ts), over the
  // same columns: the run peak copied onto the alert once its anchor retires, else the anchor's
  // live 24h peak while it is still being watched.
  const rows = await prisma.$queryRaw<Row[]>`
    WITH calls AS (
      SELECT m."filterId",
             m."hit2xIn1h" AS hit2x,
             m."hit4xIn1h" AS hit4x,
             COALESCE(m."hit10xIn1h", co."hit10xIn1h") AS hit10x,
             COALESCE(m."disqualified", false) AS dq,
             co."labelValue" AS label,
             m."peak1hReturnPct" AS peak,
             COALESCE(m."peak24hReturnPct", co."peak24hReturnPct",
                      (co."peak24hPriceUsd" / NULLIF(co."anchorPriceUsd", 0) - 1) * 100) AS run,
             m."maxDrawdown1hPct" AS dd
      FROM "UserFilter" sf
      JOIN "Match" m
        ON m."filterId" = sf."id"
       AND m."hit2xIn1h" IS NOT NULL
       AND m."matchedAt" >= GREATEST(sf."criteriaChangedAt", ${since})
      LEFT JOIN "CandidateOutcome" co ON co."id" = m."candidateOutcomeId"
      WHERE sf."shareOnLeaderboard"
    )
    SELECT f."id", f."userId", f."name", f."isActive", f."deletedAt", f."bestRank", f."criteriaChangedAt",
           f."mcapMin", f."mcapMax", f."minVolumeMcapRatio", f."minHolderGrowthPct",
           f."maxTop10HolderPct", f."maxDevWalletPct", f."maxRiskScore", f."excludeCriticalRiskFlags",
           f."minTokenAgeMinutes", f."maxTokenAgeMinutes", f."narrativeKeywords", f."minScore",
           f."maxFreshTop10WalletPct", f."maxEmptyTop10WalletPct", f."maxSniperTop10WalletPct", f."minFirstBuyersHolding",
           f."maxFirstBuyersHolding",
           count(c.hit2x) AS graded,
           count(*) FILTER (WHERE c.hit2x AND NOT c.dq) AS won2x,
           count(*) FILTER (WHERE c.hit4x AND NOT c.dq) AS won4x,
           count(*) FILTER (WHERE c.hit10x AND NOT c.dq) AS won10x,
           -- The 10x rate's denominator: losses plus clean winners whose tier has settled.
           count(*) FILTER (WHERE c.hit2x IS NOT NULL
                              AND (c.hit10x IS NOT NULL OR NOT (c.hit2x AND NOT c.dq))) AS ten_x_graded,
           COALESCE(sum(${RUN_DOUBLINGS}) FILTER (WHERE c.hit2x IS NOT NULL), 0)::float8 AS sum_run
    FROM "UserFilter" f
    LEFT JOIN calls c ON c."filterId" = f."id"
    WHERE f."shareOnLeaderboard"
    GROUP BY f."id"`;

  const entries = rows.map((r) => {
    const graded = Number(r.graded);
    const won2x = Number(r.won2x);
    const won4x = Number(r.won4x);
    const won10x = Number(r.won10x);
    const tenXGraded = Number(r.ten_x_graded);
    const sumRun = Number(r.sum_run ?? 0);
    const record = {
      calls: graded,
      graded,
      wins: won2x,
      goals: won4x,
      tenX: won10x,
      tenXGraded,
      sumLabel: 0,
      sumRun,
    };
    const score = recordScore(record, targets);
    const recordSince = r.criteriaChangedAt > since ? r.criteriaChangedAt : since;
    return {
      id: r.id,
      ownerId: r.userId,
      name: r.name,
      tag: r.id.slice(-5),
      rank: null as number | null,
      score,
      band: scoreBand(score),
      graded,
      won2x,
      won4x,
      won10x,
      winRatePct: graded > 0 ? round1((won2x / graded) * 100) : null,
      goalRatePct: graded > 0 ? round1((won4x / graded) * 100) : null,
      tenXRatePct: tenXGraded > 0 ? round1((won10x / tenXGraded) * 100) : null,
      proven2xPct: graded > 0 ? round1(provenRate(won2x, graded) * 100) : null,
      proven4xPct: graded > 0 ? round1(provenRate(won4x, graded) * 100) : null,
      avgRunDoublings: graded > 0 ? round2(sumRun / graded) : null,
      provenRunDoublings: graded > 0 ? round2(provenRate(sumRun, graded)) : null,
      recordSince: recordSince.toISOString(),
      isActive: r.isActive,
      retired: r.deletedAt !== null,
      criteria: pickCriteria(r),
      mine: false,
      bestRank: r.bestRank,
    };
  });

  const ranked = entries
    .filter((e) => e.graded >= MIN_GRADED_TO_RANK)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.graded - a.graded || a.id.localeCompare(b.id))
    .slice(0, FILTER_LEADERBOARD_SIZE)
    .map((e, i) => ({ ...e, rank: i + 1 }));
  // The best rank each filter ever held, so a deletion can tell whether it earned keeping. Only
  // the top few matter (KEEP_IF_EVER_RANKED_WITHIN), so only those are written.
  const improved = ranked.filter(
    (e) => e.rank! <= KEEP_IF_EVER_RANKED_WITHIN && (e.bestRank === null || e.bestRank > e.rank!),
  );
  await Promise.all(
    improved.map((e) => prisma.userFilter.updateMany({ where: { id: e.id }, data: { bestRank: e.rank } })),
  );
  const warmingUp = entries
    .filter((e) => e.graded < MIN_GRADED_TO_RANK)
    .sort((a, b) => b.graded - a.graded || a.id.localeCompare(b.id))
    .slice(0, WARMING_UP_SIZE);

  return {
    generatedAt: now.toISOString(),
    windowDays: TRACK_RECORD_DAYS,
    minGradedToRank: MIN_GRADED_TO_RANK,
    targets: {
      hitRate2xPct: env.CURATED_TARGET_WIN_RATE_PCT,
      hitRate4xPct: env.CURATED_TARGET_GOAL_RATE_PCT,
      runDoublings: RUN_SIZE_TARGET_DOUBLINGS,
      tenXPct: TEN_X_TARGET_RATE * 100,
    },
    ranked,
    warmingUp,
    sharedCount: entries.length,
  };
}

/** The board is the same for everyone and moves only as alerts are graded. */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_STALE_MS = 3_600_000;

export const filterLeaderboardCache = new SharedCache<CachedBoard>(CACHE_TTL_MS, {
  staleWhileRevalidateMs: CACHE_STALE_MS,
});

/** The board for one reader: their own entries flagged, every owner id dropped. */
export function boardFor(board: CachedBoard, userId: string): FilterLeaderboard {
  const strip = ({ ownerId, bestRank: _best, ...e }: CachedEntry) => ({
    ...e,
    mine: ownerId === userId,
  });
  return { ...board, ranked: board.ranked.map(strip), warmingUp: board.warmingUp.map(strip) };
}
