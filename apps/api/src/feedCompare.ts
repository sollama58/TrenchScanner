import {
  prisma,
  mixCatch,
  RUN_DOUBLINGS,
  type CatchLedger,
  type Lane,
  type LiveCatch,
} from "@trenchscanner/core";

/**
 * The Filters tab's "Compared with your selection" box: the top models' feed (what following the
 * top models shows) against the reader's own, each scored as one feed would have delivered it -
 * each token once, at its first call by any model in the mix - over the same window.
 */

/** The window the comparison reads: a week, the Models tab's board (so its catch ledger is warm). */
export const FEED_COMPARE_DAYS = 7;

/** One mix of models scored as a single feed. */
export interface FeedMixRecord {
  models: string[];
  /** Tokens the feed carried (each once), and how many of those are graded. */
  calls: number;
  graded: number;
  /** Clean 2x / 4x / 10x-within-an-hour shares of the graded calls, in percent; null with none graded. */
  hitRate2xPct: number | null;
  hitRate4xPct: number | null;
  hitRate10xPct: number | null;
  /** Average simulated return per graded call under the exit plan, in percent; null with none. */
  avgReturnPct: number | null;
  /** Average run size per graded call, in doublings (as the board's run size); null with none graded. */
  avgRunDoublings: number | null;
  /** The share of the window's runners the mix called at a winning moment (the Coverage Meter's rule). */
  catch: LiveCatch;
}

export interface FeedComparison {
  days: number;
  since: Date;
  /** The top models: what "Always follow the top models" shows. */
  best: FeedMixRecord;
  /** The reader's own picks (their checked models; the top models when they have none). */
  mine: FeedMixRecord;
  /** The two are the same set of models. */
  same: boolean;
}

interface MixRow {
  calls: bigint;
  graded: bigint;
  wins: bigint;
  goals: bigint;
  ten_x: bigint;
  ten_x_graded: bigint;
  sim_calls: bigint;
  sum_sim: number | null;
  sum_run: number | null;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/**
 * A mix of models' pooled record since `since`: their calls graded as liveCallRecords grades a
 * call (the alert's own outcome copies, else its training row), each seat from its current lane's
 * start, each token once at its first call.
 */
export async function mixFeedRecord(
  models: readonly string[],
  since: Date,
  lanes: readonly Lane[],
  ledger: CatchLedger | null,
): Promise<FeedMixRecord> {
  const ids = [...new Set(models)];
  const catchOf = (): LiveCatch => {
    if (!ledger) return { runners: 0, caught: 0, pct: null };
    const { runners, caught, pct: share } = mixCatch(ledger, ids, new Map());
    return { runners, caught, pct: share };
  };
  if (ids.length === 0) {
    return {
      models: ids,
      calls: 0,
      graded: 0,
      hitRate2xPct: null,
      hitRate4xPct: null,
      hitRate10xPct: null,
      avgReturnPct: null,
      avgRunDoublings: null,
      catch: catchOf(),
    };
  }
  const bornAt = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  const laneName = new Map(lanes.map((l) => [l.slot, l.name]));
  const froms = ids.map((m) => {
    const born = bornAt.get(m);
    return born && born > since ? born : since;
  });
  const [r] = await prisma.$queryRaw<MixRow[]>`
    WITH seats AS (
      SELECT * FROM unnest(
        ${ids}::text[],
        ${froms.map((d) => d.toISOString())}::timestamp(3)[],
        ${ids.map((m) => laneName.get(m) ?? "-")}::text[]
      ) AS s(model, since, lane)
    ),
    calls AS (
      SELECT DISTINCT ON (a."tokenId")
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."hit10xIn1h", co."hit10xIn1h") AS hit10x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             CASE WHEN a."hit2xIn1h" IS NULL THEN co."labelValue" END AS label,
             COALESCE(a."peak1hReturnPct", co."peak1hReturnPct") AS peak,
             COALESCE(a."peak24hReturnPct", co."peak24hReturnPct") AS run,
             COALESCE(a."maxDrawdown1hPct", co."maxDrawdown1hPct") AS dd,
             COALESCE(a."simReturnPct", co."simReturnPct") AS sim
      FROM "CuratedAlert" a
      JOIN seats ON seats.model = a."model" AND a."createdAt" >= seats.since
        AND (seats.lane = '-' OR a."modelName" IS NULL OR a."modelName" = seats.lane)
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${since} AND a."model" = ANY(${ids}::text[])
      ORDER BY a."tokenId", a."createdAt", a."id"
    )
    SELECT count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE hit4x AND NOT dq) AS goals,
           count(*) FILTER (WHERE hit10x AND NOT dq) AS ten_x,
           count(*) FILTER (WHERE hit2x IS NOT NULL AND (NOT (hit2x AND NOT dq) OR hit10x IS NOT NULL)) AS ten_x_graded,
           count(sim) FILTER (WHERE hit2x IS NOT NULL) AS sim_calls,
           sum(sim) FILTER (WHERE hit2x IS NOT NULL)::float8 AS sum_sim,
           sum(${RUN_DOUBLINGS}) FILTER (WHERE hit2x IS NOT NULL)::float8 AS sum_run
    FROM calls`;
  const graded = Number(r?.graded ?? 0);
  const simCalls = Number(r?.sim_calls ?? 0);
  return {
    models: ids,
    calls: Number(r?.calls ?? 0),
    graded,
    hitRate2xPct: pct(Number(r?.wins ?? 0), graded),
    hitRate4xPct: pct(Number(r?.goals ?? 0), graded),
    hitRate10xPct: pct(Number(r?.ten_x ?? 0), Number(r?.ten_x_graded ?? 0)),
    avgReturnPct: simCalls > 0 ? Math.round(((r?.sum_sim ?? 0) / simCalls) * 10) / 10 : null,
    avgRunDoublings: graded > 0 ? Math.round(((r?.sum_run ?? 0) / graded) * 100) / 100 : null,
    catch: catchOf(),
  };
}

/** A stable cache key for a mix: the same models in any order read the same record. */
export function mixKey(models: readonly string[]): string {
  return [...new Set(models)].sort().join(",");
}

export function sameMix(a: readonly string[], b: readonly string[]): boolean {
  return mixKey(a) === mixKey(b);
}
