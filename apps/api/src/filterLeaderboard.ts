import {
  type Env,
  type PrecisionTargets,
  liveCatch,
  marketRunners,
  prisma,
  recordScore,
  COMPOSITE_WEIGHTS,
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
 * settings "Copy" hands out. Its earlier versions (FilterVersion, one per criteria change) are
 * entries of their own over the alerts raised while they were current, frozen, listed only once
 * they have MIN_GRADED_TO_RANK graded alerts in the window, so a quick tweak doesn't crowd the
 * board (user decision 2026-10-18). Owners are never shown: entries carry the filter's name and a
 * short tag from its id, and `mine` is worked out per request, never stored in the shared board.
 */

/** The four scored parts of a filter's record, scaled to 100 the way recordScore scales them. */
export function filterPoints(): FilterLeaderboard["points"] {
  const w = COMPOSITE_WEIGHTS;
  const scale = 100 / (w.winRate + w.goalRate + w.tenXRate + w.runSize);
  const pts = (x: number) => Math.round(x * scale * 10) / 10;
  return {
    winRate: pts(w.winRate),
    goalRate: pts(w.goalRate),
    tenXRate: pts(w.tenXRate),
    runSize: pts(w.runSize),
  };
}

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
 * leaderboard record when edited. Name, color, icon, isActive and shareOnLeaderboard are not criteria.
 */
export const FILTER_CRITERIA_KEYS = [
  "mcapMin",
  "mcapMax",
  "minVolumeMcapRatio",
  "minHolderGrowthPct",
  "maxTop10HolderPct",
  "maxLargestHolderPct",
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
  "maxSniperTopHolderCount",
  "maxBlockZeroHeldPct",
  "maxLinkedWalletPct",
  "maxLinkedWalletCount",
  "maxFlaggedBuySol",
  "minCexFundedCount",
  "maxCexFundedCount",
  "maxSameTimeFundedPct",
  "maxSameTimeFundedCount",
  "maxLinkedCreatorPct",
  "maxKolBundledPct",
  "maxBundledSupplyPct",
  "maxTransferredSupplyPct",
  "minLiveHolderCount",
  "minFirstBuyersHolding",
  "maxFirstBuyersHolding",
  "launchpads",
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

/** UserFilter columns that aren't what it matches: identity, ownership, state and card styling. */
const NOT_CRITERIA_COLUMNS = new Set([
  "id",
  "userId",
  "name",
  "color",
  "icon",
  "isActive",
  "createdAt",
  "updatedAt",
  "armedAt",
  "shareOnLeaderboard",
  "criteriaChangedAt",
  "bestRank",
  "deletedAt",
]);

/**
 * A filter row's matching columns, as a FilterVersion keeps them: every column but identity,
 * state and styling, so a copy of an earlier version gets everything a copy of the current one does.
 */
export function criteriaSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !NOT_CRITERIA_COLUMNS.has(k)));
}

/** An earlier version's board entry id: the filter's id and the version, e.g. "ck...-v2". */
export function versionEntryId(filterId: string, version: number): string {
  return `${filterId}-v${version}`;
}

/** The filter id and version an entry id names (version null: the filter's current settings). */
export function parseEntryId(id: string): { filterId: string; version: number | null } {
  const m = /^(.+)-v(\d+)$/.exec(id);
  return m ? { filterId: m[1]!, version: Number(m[2]) } : { filterId: id, version: null };
}

export interface FilterLeaderboardEntry {
  /** The filter's id, or versionEntryId for an earlier version. */
  id: string;
  /** Which version of the filter's settings this record is (1 = its first). */
  version: number;
  /** The filter's current version; above `version` on an earlier version's entry. */
  latestVersion: number;
  /** An earlier version: its owner has since changed the settings, so it never alerts again. */
  superseded: boolean;
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
  /**
   * Its catch: of the runners since its record starts (tokens that doubled cleanly from a graded
   * market moment, or from a shared filter's alert - the model board's rule, see liveCatch), how
   * many it alerted on at a winning moment. Null `pct` with no runners yet.
   */
  catch: { runners: number; caught: number; pct: number | null };
  /** Where the record starts: the later of the window start and the last criteria change. */
  recordSince: string;
  /** Whether its owner has it switched on now (only a filter that is on raises alerts). */
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
  /**
   * The points each part of a filter's score is worth. A filter's record has no catch or return
   * part, so the model scorecard's other four are scaled to 100 (recordScore's partsTotal).
   */
  points: { winRate: number; goalRate: number; tenXRate: number; runSize: number };
  ranked: FilterLeaderboardEntry[];
  warmingUp: FilterLeaderboardEntry[];
  /** Every shared filter, ranked or not (the lists above are capped). */
  sharedCount: number;
}

/** The board as cached: entries keep their owner id, stripped before anything is sent. */
type CachedEntry = FilterLeaderboardEntry & { ownerId: string; bestRank: number | null; filterId: string };
interface CachedBoard extends Omit<FilterLeaderboard, "ranked" | "warmingUp"> {
  ranked: CachedEntry[];
  warmingUp: CachedEntry[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

type Tally = {
  key: string;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  sum_run: number | null;
};

export async function buildFilterLeaderboard(env: Env, now = new Date()): Promise<CachedBoard> {
  const since = new Date(now.getTime() - TRACK_RECORD_DAYS * 86_400_000);
  const targets: PrecisionTargets = {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
  // Each record's stretch of a shared filter's alerts, keyed by its entry id: the current settings
  // from criteriaChangedAt on, each earlier version from its startedAt until its endedAt, all
  // clipped to the window. Records are counted in one pass over the graded alerts, through Match's
  // filterId index. Only graded rows count (hit2xIn1h set); the verdicts are the ones copied from
  // each alert's own anchor. Run size is the model score's own measure (RUN_DOUBLINGS,
  // curation/laneStore.ts), over the same columns: the run peak copied onto the alert once its
  // anchor retires, else the anchor's live 24h peak while it is still being watched.
  const [filters, tallies] = await Promise.all([
    prisma.userFilter.findMany({
      where: { shareOnLeaderboard: true },
      include: { versions: { where: { endedAt: { gt: since } } }, _count: { select: { versions: true } } },
    }),
    prisma.$queryRaw<Tally[]>`
    WITH spans AS (
      SELECT sf."id" AS key, sf."id" AS "filterId",
             GREATEST(sf."criteriaChangedAt", ${since}) AS "from", 'infinity'::timestamp(3) AS "to"
      FROM "UserFilter" sf
      WHERE sf."shareOnLeaderboard"
      UNION ALL
      SELECT sf."id" || '-v' || v."version", sf."id", GREATEST(v."startedAt", ${since}), v."endedAt"
      FROM "FilterVersion" v
      JOIN "UserFilter" sf ON sf."id" = v."filterId"
      WHERE sf."shareOnLeaderboard" AND v."endedAt" > ${since}
    ), calls AS (
      SELECT s.key,
             m."hit2xIn1h" AS hit2x,
             m."hit4xIn1h" AS hit4x,
             COALESCE(m."hit10xIn1h", co."hit10xIn1h") AS hit10x,
             COALESCE(m."disqualified", false) AS dq,
             co."labelValue" AS label,
             m."peak1hReturnPct" AS peak,
             COALESCE(m."peak24hReturnPct", co."peak24hReturnPct",
                      (co."peak24hPriceUsd" / NULLIF(co."anchorPriceUsd", 0) - 1) * 100) AS run,
             m."maxDrawdown1hPct" AS dd
      FROM spans s
      JOIN "Match" m
        ON m."filterId" = s."filterId"
       AND m."hit2xIn1h" IS NOT NULL
       AND m."matchedAt" >= s."from"
       AND m."matchedAt" < s."to"
      LEFT JOIN "CandidateOutcome" co ON co."id" = m."candidateOutcomeId"
    )
    SELECT c.key,
           count(c.hit2x) AS graded,
           count(*) FILTER (WHERE c.hit2x AND NOT c.dq) AS won2x,
           count(*) FILTER (WHERE c.hit4x AND NOT c.dq) AS won4x,
           count(*) FILTER (WHERE c.hit10x AND NOT c.dq) AS won10x,
           -- The 10x rate's denominator: losses plus clean winners whose tier has settled.
           count(*) FILTER (WHERE c.hit2x IS NOT NULL
                              AND (c.hit10x IS NOT NULL OR NOT (c.hit2x AND NOT c.dq))) AS ten_x_graded,
           COALESCE(sum(${RUN_DOUBLINGS}) FILTER (WHERE c.hit2x IS NOT NULL), 0)::float8 AS sum_run
    FROM calls c
    GROUP BY c.key`,
  ]);
  const tallyOf = new Map(tallies.map((t) => [t.key, t]));

  // Every record the board can list: each shared filter's current settings, and its earlier
  // versions still inside the window.
  const records = filters.flatMap((f) => {
    const latestVersion = f._count.versions + 1;
    const current = {
      key: f.id,
      filter: f,
      version: latestVersion,
      latestVersion,
      from: f.criteriaChangedAt > since ? f.criteriaChangedAt : since,
      criteria: pickCriteria(f),
      bestRank: f.bestRank,
    };
    const earlier = f.versions.map((v) => ({
      key: versionEntryId(f.id, v.version),
      filter: f,
      version: v.version,
      latestVersion,
      from: v.startedAt > since ? v.startedAt : since,
      criteria: pickCriteria((v.criteria ?? {}) as Record<string, unknown>),
      bestRank: v.bestRank,
    }));
    return [current, ...earlier];
  });

  // Catch, over the same alerts and window: each record's clean 2x alerts, by token.
  const [market, wins] = await Promise.all([
    marketRunners(since),
    prisma.$queryRaw<{ filterId: string; token: string; at: Date }[]>`
      WITH spans AS (
        SELECT sf."id" AS key, sf."id" AS "filterId",
               GREATEST(sf."criteriaChangedAt", ${since}) AS "from", 'infinity'::timestamp(3) AS "to"
        FROM "UserFilter" sf
        WHERE sf."shareOnLeaderboard"
        UNION ALL
        SELECT sf."id" || '-v' || v."version", sf."id", GREATEST(v."startedAt", ${since}), v."endedAt"
        FROM "FilterVersion" v
        JOIN "UserFilter" sf ON sf."id" = v."filterId"
        WHERE sf."shareOnLeaderboard" AND v."endedAt" > ${since}
      )
      SELECT s.key AS "filterId", m."tokenId" AS token, max(m."matchedAt") AS at
      FROM spans s
      JOIN "Match" m
        ON m."filterId" = s."filterId"
       AND m."hit2xIn1h" AND NOT COALESCE(m."disqualified", false)
       AND m."matchedAt" >= s."from"
       AND m."matchedAt" < s."to"
      GROUP BY 1, 2`,
  ]);
  const catches = liveCatch(
    [...market, ...wins],
    wins.map((w) => ({ model: w.filterId, token: w.token })),
    new Map(records.map((r) => [r.key, r.from] as const)),
  ).byModel;

  const all = records.map((r) => {
    const t = tallyOf.get(r.key);
    const graded = Number(t?.graded ?? 0);
    const won2x = Number(t?.won2x ?? 0);
    const won4x = Number(t?.won4x ?? 0);
    const won10x = Number(t?.won10x ?? 0);
    const tenXGraded = Number(t?.ten_x_graded ?? 0);
    const sumRun = Number(t?.sum_run ?? 0);
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
    const superseded = r.version < r.latestVersion;
    return {
      id: r.key,
      filterId: r.filter.id,
      ownerId: r.filter.userId,
      name: r.filter.name,
      tag: r.filter.id.slice(-5),
      version: r.version,
      latestVersion: r.latestVersion,
      superseded,
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
      catch: catches.get(r.key) ?? { runners: 0, caught: 0, pct: null },
      recordSince: r.from.toISOString(),
      isActive: r.filter.isActive && !superseded,
      retired: r.filter.deletedAt !== null,
      criteria: r.criteria,
      mine: false,
      bestRank: r.bestRank,
    };
  });
  // An earlier version is listed only once it has a rankable record: it can't grow any more, and
  // a version that was replaced before it proved anything would only crowd the board.
  const entries = all.filter((e) => !e.superseded || e.graded >= MIN_GRADED_TO_RANK);

  const ranked = entries
    .filter((e) => e.graded >= MIN_GRADED_TO_RANK)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.graded - a.graded || a.id.localeCompare(b.id))
    .slice(0, FILTER_LEADERBOARD_SIZE)
    .map((e, i) => ({ ...e, rank: i + 1 }));
  // The best rank each filter or version ever held, so a deletion can tell whether it earned keeping. Only
  // the top few matter (KEEP_IF_EVER_RANKED_WITHIN), so only those are written.
  const improved = ranked.filter(
    (e) => e.rank! <= KEEP_IF_EVER_RANKED_WITHIN && (e.bestRank === null || e.bestRank > e.rank!),
  );
  await Promise.all(
    improved.map((e) =>
      e.superseded
        ? prisma.filterVersion.updateMany({
            where: { filterId: e.filterId, version: e.version },
            data: { bestRank: e.rank },
          })
        : prisma.userFilter.updateMany({ where: { id: e.id }, data: { bestRank: e.rank } }),
    ),
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
    points: filterPoints(),
    ranked,
    warmingUp,
    sharedCount: filters.length,
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
  const strip = ({ ownerId, bestRank: _best, filterId: _filter, ...e }: CachedEntry) => ({
    ...e,
    mine: ownerId === userId,
  });
  return { ...board, ranked: board.ranked.map(strip), warmingUp: board.warmingUp.map(strip) };
}
