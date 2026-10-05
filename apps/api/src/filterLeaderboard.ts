import {
  type Env,
  type PrecisionTargets,
  prisma,
  recordScore,
  scoreBand,
  provenRate,
  TRACK_RECORD_DAYS,
} from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";

/**
 * The public filter leaderboard: saved filters whose owners opted in (UserFilter.shareOnLeaderboard),
 * ranked by the same 0-100 score as the model contest (curation/leaderboard.ts: how far the
 * filter's PROVEN 2x and 4x rates reach toward the 75% / 50% targets), on its alerts' own
 * verdicts - 2x within 15 minutes of the alert price, 4x within 30, a 50% drop first is a loss.
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
  "minFirstBuyersHolding",
  "maxFirstBuyersHolding",
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
  winRatePct: number | null;
  goalRatePct: number | null;
  proven2xPct: number | null;
  proven4xPct: number | null;
  /** Where the record starts: the later of the window start and the last criteria change. */
  recordSince: string;
  /** Whether it is its owner's active filter now (only an active filter raises alerts). */
  isActive: boolean;
  criteria: FilterCriteria;
  /** The caller's own filter - set per request. */
  mine: boolean;
}

export interface FilterLeaderboard {
  generatedAt: string;
  windowDays: number;
  minGradedToRank: number;
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  ranked: FilterLeaderboardEntry[];
  warmingUp: FilterLeaderboardEntry[];
  /** Every shared filter, ranked or not (the lists above are capped). */
  sharedCount: number;
}

/** The board as cached: entries keep their owner id, stripped before anything is sent. */
interface CachedBoard extends Omit<FilterLeaderboard, "ranked" | "warmingUp"> {
  ranked: (FilterLeaderboardEntry & { ownerId: string })[];
  warmingUp: (FilterLeaderboardEntry & { ownerId: string })[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

type Row = {
  id: string;
  userId: string;
  name: string;
  isActive: boolean;
  criteriaChangedAt: Date;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
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
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT f."id", f."userId", f."name", f."isActive", f."criteriaChangedAt",
           f."mcapMin", f."mcapMax", f."minVolumeMcapRatio", f."minHolderGrowthPct",
           f."maxTop10HolderPct", f."maxDevWalletPct", f."maxRiskScore", f."excludeCriticalRiskFlags",
           f."minTokenAgeMinutes", f."maxTokenAgeMinutes", f."narrativeKeywords", f."minScore",
           f."maxFreshTop10WalletPct", f."maxEmptyTop10WalletPct", f."minFirstBuyersHolding",
           f."maxFirstBuyersHolding",
           count(m."id") AS graded,
           count(m."id") FILTER (WHERE m."hit2xIn1h" AND NOT COALESCE(m."disqualified", false)) AS won2x,
           count(m."id") FILTER (WHERE m."hit4xIn1h") AS won4x
    FROM "UserFilter" f
    LEFT JOIN "Match" m
      ON m."filterId" = f."id"
     AND m."hit2xIn1h" IS NOT NULL
     AND m."matchedAt" >= GREATEST(f."criteriaChangedAt", ${since})
    WHERE f."shareOnLeaderboard"
    GROUP BY f."id"`;

  const entries = rows.map((r) => {
    const graded = Number(r.graded);
    const won2x = Number(r.won2x);
    const won4x = Number(r.won4x);
    const record = { calls: graded, graded, wins: won2x, goals: won4x, sumLabel: 0 };
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
      winRatePct: graded > 0 ? round1((won2x / graded) * 100) : null,
      goalRatePct: graded > 0 ? round1((won4x / graded) * 100) : null,
      proven2xPct: graded > 0 ? round1(provenRate(won2x, graded) * 100) : null,
      proven4xPct: graded > 0 ? round1(provenRate(won4x, graded) * 100) : null,
      recordSince: recordSince.toISOString(),
      isActive: r.isActive,
      criteria: pickCriteria(r),
      mine: false,
    };
  });

  const ranked = entries
    .filter((e) => e.graded >= MIN_GRADED_TO_RANK)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.graded - a.graded || a.id.localeCompare(b.id))
    .slice(0, FILTER_LEADERBOARD_SIZE)
    .map((e, i) => ({ ...e, rank: i + 1 }));
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
  const strip = ({ ownerId, ...e }: FilterLeaderboardEntry & { ownerId: string }) => ({
    ...e,
    mine: ownerId === userId,
  });
  return { ...board, ranked: board.ranked.map(strip), warmingUp: board.warmingUp.map(strip) };
}
