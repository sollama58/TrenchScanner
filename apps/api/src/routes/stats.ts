import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  prisma,
  createLogger,
  describeExitPlan,
  HEURISTIC_CURATOR_SOURCE,
  WIN_WINDOW_MINUTES,
  GOAL_WINDOW_MINUTES,
  CANDIDATE_EXTENDED_WATCH_HOURS,
  type Env,
} from "@trenchscanner/core";
import type { RouteTimings } from "../routeTimings.js";
import { SharedCache } from "../sharedCache.js";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import { exportQuerySchema, exportWindow, startExport } from "./statsExport.js";

const logger = createLogger("stats");

const DAY_MS = 86_400_000;

/** A token shorter than this switches the endpoint off rather than guarding it weakly. */
export const STATS_TOKEN_MIN_LENGTH = 32;

/** Below this many graded calls a rate is reported but not held against the targets. */
export const MIN_GRADED_FOR_VERDICT = 30;

/** Tight: this is a script's endpoint, and every call runs a dozen aggregates. */
const STATS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

/** Longest window one report may cover, whichever way the caller spells it (days, or since/until). */
export const MAX_WINDOW_DAYS = 180;

/** The window a since/until/days query asks for, in days, resolved the way the routes resolve it. */
export function windowDays(q: { days: number; since?: Date; until?: Date }, now = new Date()): number {
  const until = q.until ?? now;
  const since = q.since ?? new Date(until.getTime() - q.days * DAY_MS);
  return (until.getTime() - since.getTime()) / DAY_MS;
}

const querySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(MAX_WINDOW_DAYS).default(30),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
  })
  .refine((q) => !q.since || !q.until || q.since < q.until, { message: "since must be before until" })
  // `since` alone used to open the whole table: the cap on `days` only bound the default window.
  .refine((q) => windowDays(q) <= MAX_WINDOW_DAYS, {
    message: `window must be at most ${MAX_WINDOW_DAYS} days`,
  });

/** One group of graded calls - the shape every section of the report is built from. */
export interface GradedCounts {
  /** Calls made in the window. */
  calls: number;
  /** Calls whose verdict is in (the rest are still inside their window, or lost their anchor). */
  graded: number;
  /** Doubled within 15 minutes from the alert price without first falling through the 50% stop. */
  won2x: number;
  /** Reached 4x within 30 minutes from the alert price, stop respected. */
  won4x: number;
  /** Doubled only after first falling through the stop - counted as losses. */
  doubledAfterStop: number;
  /**
   * Graded calls with a simulated return under the fixed exit plan (curation/profitSim.ts), and
   * the sum of those returns in percent of a stake. Absent where the source has no such number.
   */
  simCalls?: number;
  sumSimReturnPct?: number;
  /**
   * Calls with no verdict that never will get one, so they are not "pending" either. Filter
   * alerts: a Match with no grading anchor (every match before grading shipped on 2026-10-03, or
   * one whose anchor write failed) has nothing for the watcher to close. Curated alerts: the row
   * closed with no price inside the win window (a worker outage, or a mint with no price), so the
   * watcher retired it ungraded.
   */
  ungradable?: number;
}

export interface GradedRates extends GradedCounts {
  pending: number;
  hitRate2xPct: number | null;
  hitRate4xPct: number | null;
  /** Average simulated return per graded call under the exit plan, in percent; null with none. */
  avgSimReturnPct: number | null;
  /** Total simulated return, in percent of one stake (one stake per call); null with none. */
  totalSimReturnPct: number | null;
  /**
   * Held against CURATED_TARGET_WIN_RATE_PCT / CURATED_TARGET_GOAL_RATE_PCT. "insufficient-data"
   * below MIN_GRADED_FOR_VERDICT graded calls - a 3-for-4 start says nothing yet.
   */
  verdict: "meets-targets" | "below-targets" | "insufficient-data";
}

export interface Targets {
  hitRate2xPct: number;
  hitRate4xPct: number;
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** Turns raw counts into the rates and target verdict the report shows. */
export function withRates(
  c: GradedCounts,
  targets: Targets,
  minGraded = MIN_GRADED_FOR_VERDICT,
): GradedRates {
  const hitRate2xPct = pct(c.won2x, c.graded);
  const hitRate4xPct = pct(c.won4x, c.graded);
  let verdict: GradedRates["verdict"] = "insufficient-data";
  if (c.graded >= minGraded) {
    verdict =
      (hitRate2xPct ?? 0) >= targets.hitRate2xPct && (hitRate4xPct ?? 0) >= targets.hitRate4xPct
        ? "meets-targets"
        : "below-targets";
  }
  const simCalls = c.simCalls ?? 0;
  const simSum = c.sumSimReturnPct ?? 0;
  return {
    ...c,
    pending: c.calls - c.graded - (c.ungradable ?? 0),
    hitRate2xPct,
    hitRate4xPct,
    avgSimReturnPct: simCalls > 0 ? Math.round((simSum / simCalls) * 10) / 10 : null,
    totalSimReturnPct: simCalls > 0 ? Math.round(simSum * 10) / 10 : null,
    verdict,
  };
}

/** Sums groups into one - for the totals line above a breakdown. */
export function sumCounts(rows: GradedCounts[]): GradedCounts {
  return rows.reduce<GradedCounts>(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      graded: acc.graded + r.graded,
      won2x: acc.won2x + r.won2x,
      won4x: acc.won4x + r.won4x,
      doubledAfterStop: acc.doubledAfterStop + r.doubledAfterStop,
      ...(acc.ungradable !== undefined || r.ungradable !== undefined
        ? { ungradable: (acc.ungradable ?? 0) + (r.ungradable ?? 0) }
        : {}),
      ...(acc.simCalls !== undefined || r.simCalls !== undefined
        ? {
            simCalls: (acc.simCalls ?? 0) + (r.simCalls ?? 0),
            sumSimReturnPct: (acc.sumSimReturnPct ?? 0) + (r.sumSimReturnPct ?? 0),
          }
        : {}),
    }),
    { calls: 0, graded: 0, won2x: 0, won4x: 0, doubledAfterStop: 0 },
  );
}

/**
 * Constant-time bearer check. Both sides are hashed first so the comparison length never depends
 * on the guess, and timingSafeEqual never throws on a length mismatch.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const a = createHash("sha256").update(match[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Postgres returns count(*) as bigint; every column of a counts row comes back through here. */
type RawCounts = {
  calls: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  doubled_after_stop: bigint;
  /** Only on the queries that read a simulated return. */
  sim_calls?: bigint;
  sim_sum?: number | null;
  /** Only on the queries whose calls can close with no verdict. */
  ungradable?: bigint;
};

function toCounts(r: RawCounts): GradedCounts {
  return {
    calls: Number(r.calls),
    graded: Number(r.graded),
    won2x: Number(r.won2x),
    won4x: Number(r.won4x),
    doubledAfterStop: Number(r.doubled_after_stop),
    ...(r.sim_calls !== undefined
      ? { simCalls: Number(r.sim_calls), sumSimReturnPct: Number(r.sim_sum ?? 0) }
      : {}),
    ...(r.ungradable !== undefined ? { ungradable: Number(r.ungradable) } : {}),
  };
}

/**
 * The read-only hit-rate report: how production alerts grade under the current rules - a win is
 * 2x within 15 minutes (goal 4x within 30) of the alert price, and a 50% drop before the double is a loss
 * (see curation/labels.ts). Every figure comes from the same CandidateOutcome labels the feed's
 * own stats use; nothing here grades anything itself.
 *
 * Not behind a session: it exists for scripts and cloud sessions that can reach the API over
 * HTTPS but not the database. Guarded by STATS_API_TOKEN instead, and absent (404) without one.
 */
export async function registerStatsRoutes(
  app: FastifyInstance,
  opts: { env: Env; timings?: RouteTimings; liveRefresher?: OnDemandLiveRefresher },
) {
  const token = opts.env.STATS_API_TOKEN;
  const enabled = token.length >= STATS_TOKEN_MIN_LENGTH;
  if (token && !enabled) {
    logger.warn(`STATS_API_TOKEN is shorter than ${STATS_TOKEN_MIN_LENGTH} characters - /stats is disabled`);
  }

  const targets: Targets = {
    hitRate2xPct: opts.env.CURATED_TARGET_WIN_RATE_PCT,
    hitRate4xPct: opts.env.CURATED_TARGET_GOAL_RATE_PCT,
  };

  async function guard(request: FastifyRequest, reply: FastifyReply) {
    if (!enabled) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    if (!bearerMatches(request.headers.authorization, token)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  }

  app.get(
    "/hit-rates",
    { config: { rateLimit: STATS_RATE_LIMIT }, preHandler: guard },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        return;
      }
      const until = parsed.data.until ?? new Date();
      const since = parsed.data.since ?? new Date(until.getTime() - parsed.data.days * DAY_MS);
      reply.header("cache-control", "no-store");
      return buildHitRateReport(since, until, targets, opts.env);
    },
  );
  /**
   * What the database is busy with right now, and how big the hot tables are - the half of the
   * worker's performance that /health/worker's stage timings can't explain on their own (a stage
   * that is slow because its query is slow, or because the database is saturated by something
   * else). Same token guard as the report above. Statement text is Prisma's parameterized SQL, so
   * it carries placeholders, never bound values.
   */
  app.get("/db", { config: { rateLimit: STATS_RATE_LIMIT }, preHandler: guard }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return buildDbReport();
  });

  /**
   * Where the database's disk goes and how fast each table fills: every table's heap, TOAST and
   * index size with rows inserted/deleted since the stats reset, a week of daily row counts for
   * the tables that grow with launches, and a 1% sample of TokenSnapshot split by how old each row
   * is and whether its token ever mattered (a training row, a filter alert, a curated call). This
   * is what retention is tuned from - see apps/worker/src/jobs/cleanupJob.ts.
   */
  // A full Token scan plus a snapshot sample: one fill serves every reader for a while, so a
  // script polling it can't keep the database busy with it.
  const storageCache = new SharedCache<Awaited<ReturnType<typeof buildStorageReport>>>(5 * 60_000);
  app.get(
    "/storage",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } }, preHandler: guard },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return storageCache.get(buildStorageReport);
    },
  );

  /**
   * How long each API route has been taking to answer on this instance: count, p50/p95/p99, max
   * and the 5xx share, slowest p95 first - see routeTimings.ts. The dashboard's routes all need a
   * subscriber session, so this is how a script sees their real speed.
   */
  app.get(
    "/routes",
    { config: { rateLimit: STATS_RATE_LIMIT }, preHandler: guard },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        since: opts.timings?.since ?? null,
        uptimeSeconds: Math.round(process.uptime()),
        routes: opts.timings?.summary() ?? [],
      };
    },
  );

  /**
   * Row-level data for offline research: training rows (with features, labels and the stored
   * price aggregates), their snapshot price paths, curated alerts, shadow picks and AI reviews,
   * for a date range, as gzipped JSONL or CSV. Read-only and streamed a page at a time, so a
   * 60-day pull never sits in memory. See statsExport.ts for the datasets and their columns.
   */
  app.get(
    "/export",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } }, compress: false, preHandler: guard },
    async (request, reply) => {
      const parsed = exportQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        return;
      }
      const q = parsed.data;
      const { since, until } = exportWindow(q);
      const stream = startExport(q, since, until);
      if (!stream) {
        reply.code(429).send({ error: "export_busy" });
        return;
      }
      const day = (d: Date) => d.toISOString().slice(0, 10);
      reply
        .header("cache-control", "no-store")
        .header("content-type", "application/gzip")
        .header(
          "content-disposition",
          `attachment; filename="trenchscanner-${q.dataset}-${day(since)}-${day(until)}.${q.format}.gz"`,
        );
      return reply.send(stream);
    },
  );

  /**
   * How fresh the market caps on open pages really are: the age of every live reading for tokens
   * a page fetched in the last two minutes, and what this instance's live refresher has spent
   * keeping them that way (see liveRefresh.ts and routes/live.ts).
   */
  app.get(
    "/live",
    { config: { rateLimit: STATS_RATE_LIMIT }, preHandler: guard },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return buildLiveFreshnessReport(opts.liveRefresher);
    },
  );
}

/** The /stats/live report; the admin panel's API section shows the same figures. */
export async function buildLiveFreshnessReport(liveRefresher?: OnDemandLiveRefresher) {
  const [ages] = await prisma.$queryRaw<
    { viewed: bigint; withReading: bigint; p50: number | null; p95: number | null; max: number | null }[]
  >`
    SELECT count(*) AS viewed,
           count("liveDataAt") AS "withReading",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM now() - "liveDataAt")) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now() - "liveDataAt")) AS p95,
           max(extract(epoch FROM now() - "liveDataAt"))::float8 AS max
    FROM "Token"
    WHERE "lastViewedAt" > now() - interval '2 minutes'`;
  const round = (v: number | null | undefined) =>
    v === null || v === undefined ? null : Math.round(v * 10) / 10;
  return {
    viewedLast2Min: Number(ages?.viewed ?? 0),
    withLiveReading: Number(ages?.withReading ?? 0),
    readingAgeSeconds: { p50: round(ages?.p50), p95: round(ages?.p95), max: round(ages?.max) },
    refresher: liveRefresher?.stats() ?? null,
  };
}

interface WinnerRunRow {
  population: string;
  winners: bigint;
  finished: bigint;
  median_multiple: number | null;
  best_multiple: number | null;
  reached_4x: bigint;
  reached_10x: bigint;
  median_minutes: number | null;
}

/** One population's winner runs, as the report shows them. */
export function toWinnerRuns(r: WinnerRunRow) {
  const finished = Number(r.finished);
  const round1 = (v: number | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);
  const share = (n: bigint) => (finished > 0 ? Math.round((Number(n) / finished) * 1000) / 10 : null);
  return {
    population: r.population,
    /** Clean winners in the window. */
    winners: Number(r.winners),
    /** Of those, how many have finished their run watch (the rest are still being watched). */
    finished,
    /** The median winner's run peak, as a multiple of the alert price. */
    medianPeakMultiple: round1(r.median_multiple),
    bestPeakMultiple: round1(r.best_multiple),
    /** Share of finished winners whose run went on to 4x / 10x at some point in the 24h watch. */
    reached4xPct: share(r.reached_4x),
    reached10xPct: share(r.reached_10x),
    /** Median minutes from the alert to the run peak. */
    medianMinutesToPeak: round1(r.median_minutes),
  };
}

/** Exported for the route test; the route above is the only caller in production. */
export async function buildHitRateReport(
  since: Date,
  until: Date,
  targets: Targets,
  env: Env,
  // The Model tab never shows per-filter rows, and the Match aggregate is the report's heaviest
  // read, so it asks for the report without them.
  opts: { includeFilterMatches?: boolean } = {},
) {
  // A curated alert carries outcome copies once its window closes; until the copy lands (or after
  // its training row is pruned) the linked row is the other source. Either way the same label.
  const curatedRows = prisma.$queryRaw<(RawCounts & { source: string })[]>`
    SELECT a."source" AS source,
           count(*) AS calls,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS graded,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h")
                              AND NOT COALESCE(a."disqualified", co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE COALESCE(a."hit4xIn1h", co."hit4xIn1h")) AS won4x,
           count(*) FILTER (WHERE COALESCE(a."disqualified", co."disqualified")) AS doubled_after_stop,
           count(COALESCE(a."simReturnPct", co."simReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS sim_calls,
           sum(COALESCE(a."simReturnPct", co."simReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL)::float8 AS sim_sum,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NULL
                              AND (a."outcomeFinalizedAt" IS NOT NULL
                                   OR (co."finalized24hAt" IS NOT NULL AND co."finalizedAt" IS NULL))) AS ungradable
    FROM "CuratedAlert" a
    LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
    WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until}
    GROUP BY a."source"
    ORDER BY calls DESC`;

  // The same calls by contestant ledger (CuratedAlert.model) - the curator contest's live records.
  const modelRows = prisma.$queryRaw<(RawCounts & { model: string })[]>`
    SELECT COALESCE(a."model", 'unassigned') AS model,
           count(*) AS calls,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS graded,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h")
                              AND NOT COALESCE(a."disqualified", co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE COALESCE(a."hit4xIn1h", co."hit4xIn1h")) AS won4x,
           count(*) FILTER (WHERE COALESCE(a."disqualified", co."disqualified")) AS doubled_after_stop,
           count(COALESCE(a."simReturnPct", co."simReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS sim_calls,
           sum(COALESCE(a."simReturnPct", co."simReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL)::float8 AS sim_sum,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NULL
                              AND (a."outcomeFinalizedAt" IS NOT NULL
                                   OR (co."finalized24hAt" IS NOT NULL AND co."finalizedAt" IS NULL))) AS ungradable
    FROM "CuratedAlert" a
    LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
    WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until}
    GROUP BY 1
    ORDER BY calls DESC`;

  // The same calls by conviction tier (CuratedAlert.tier): the high-conviction tier is the
  // precision-curve top the feed is operated by, so its own rate is the one to watch.
  const tierRows = prisma.$queryRaw<(RawCounts & { tier: string })[]>`
    SELECT COALESCE(a."tier", 'untiered') AS tier,
           count(*) AS calls,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS graded,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h")
                              AND NOT COALESCE(a."disqualified", co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE COALESCE(a."hit4xIn1h", co."hit4xIn1h")) AS won4x,
           count(*) FILTER (WHERE COALESCE(a."disqualified", co."disqualified")) AS doubled_after_stop,
           count(COALESCE(a."simReturnPct", co."simReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS sim_calls,
           sum(COALESCE(a."simReturnPct", co."simReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL)::float8 AS sim_sum,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NULL
                              AND (a."outcomeFinalizedAt" IS NOT NULL
                                   OR (co."finalized24hAt" IS NOT NULL AND co."finalizedAt" IS NULL))) AS ungradable
    FROM "CuratedAlert" a
    LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
    WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until}
    GROUP BY 1
    ORDER BY 1`;

  // Data continuity: when the newest training sample was banked, and how many in the last hour.
  // A feed that has stopped banking samples has stopped learning.
  const continuityRows = prisma.$queryRaw<{ newest: Date | null; last_hour: bigint }[]>`
    SELECT max("anchorAt") AS newest,
           count(*) FILTER (WHERE "anchorAt" >= now() - INTERVAL '1 hour') AS last_hour
    FROM "CandidateOutcome"
    WHERE "sampleKind" IN ('hourly', 'event') AND "anchorAt" >= now() - INTERVAL '7 days'`;

  const shadowRows = prisma.$queryRaw<(RawCounts & { source: string })[]>`
    SELECT s."source" AS source,
           count(*) AS calls,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE co."disqualified") AS doubled_after_stop,
           count(co."simReturnPct") FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS sim_calls,
           sum(co."simReturnPct") FILTER (WHERE co."hit2xIn1h" IS NOT NULL)::float8 AS sim_sum
    FROM "CuratedShadowEmission" s
    LEFT JOIN "CandidateOutcome" co ON co."id" = s."candidateOutcomeId"
    WHERE s."createdAt" >= ${since} AND s."createdAt" < ${until}
    GROUP BY s."source"
    ORDER BY calls DESC`;

  // Confidence bands across both curators' live and shadow calls - where a cutoff would have to
  // sit for the calls above it to reach the targets.
  const confidenceRows = prisma.$queryRaw<(RawCounts & { side: string; band: number })[]>`
    WITH calls AS (
      SELECT a."source", a."confidence",
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."disqualified", co."disqualified") AS dq
      FROM "CuratedAlert" a
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until}
      UNION ALL
      SELECT s."source", s."confidence", co."hit2xIn1h", co."hit4xIn1h", co."disqualified"
      FROM "CuratedShadowEmission" s
      LEFT JOIN "CandidateOutcome" co ON co."id" = s."candidateOutcomeId"
      WHERE s."createdAt" >= ${since} AND s."createdAt" < ${until}
    )
    SELECT CASE WHEN "source" = ${HEURISTIC_CURATOR_SOURCE} THEN 'heuristic' ELSE 'model' END AS side,
           (LEAST(GREATEST(floor("confidence" / 10), 0), 9) * 10)::int AS band,
           count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT COALESCE(dq, false)) AS won2x,
           count(*) FILTER (WHERE hit4x) AS won4x,
           count(*) FILTER (WHERE dq) AS doubled_after_stop
    FROM calls
    GROUP BY 1, 2
    ORDER BY 1, 2`;

  const aiRows = prisma.$queryRaw<(RawCounts & { mode: string; decision: string })[]>`
    SELECT r."mode" AS mode,
           COALESCE(r."decision", 'error') AS decision,
           count(*) AS calls,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE co."disqualified") AS doubled_after_stop,
           count(co."simReturnPct") FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS sim_calls,
           sum(co."simReturnPct") FILTER (WHERE co."hit2xIn1h" IS NOT NULL)::float8 AS sim_sum
    FROM "AiReview" r
    LEFT JOIN "CandidateOutcome" co ON co."id" = r."candidateOutcomeId"
    WHERE r."createdAt" >= ${since} AND r."createdAt" < ${until}
    GROUP BY 1, 2
    ORDER BY 1, 2`;

  // The reviewer's stated 2x probability against what happened - is it calibrated?
  const aiProbabilityRows = prisma.$queryRaw<(RawCounts & { band: number })[]>`
    SELECT (LEAST(GREATEST(floor(r."probability2x" * 10), 0), 9) * 10)::int AS band,
           count(*) AS calls,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE co."disqualified") AS doubled_after_stop
    FROM "AiReview" r
    LEFT JOIN "CandidateOutcome" co ON co."id" = r."candidateOutcomeId"
    WHERE r."createdAt" >= ${since} AND r."createdAt" < ${until} AND r."probability2x" IS NOT NULL
    GROUP BY 1
    ORDER BY 1`;

  // Per playbook: the buy record, and how well both odds - the reviewer's and the default model's
  // own - called the 2x (Brier: mean squared error against the outcome, 0.25 = a coin flip).
  const aiPlaybookRows = prisma.$queryRaw<
    (RawCounts & {
      playbookId: string;
      brier_sum: number | null;
      brier_n: bigint;
      curator_brier_sum: number | null;
      curator_brier_n: bigint;
    })[]
  >`
    WITH graded AS (
      SELECT r."playbookId", r."decision", r."probability2x", r."curatorProbability",
             co."hit2xIn1h", co."hit4xIn1h", co."disqualified",
             CASE WHEN co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false) THEN 1 ELSE 0 END AS won
      FROM "AiReview" r
      LEFT JOIN "CandidateOutcome" co ON co."id" = r."candidateOutcomeId"
      WHERE r."createdAt" >= ${since} AND r."createdAt" < ${until} AND r."decision" IS NOT NULL
    )
    SELECT COALESCE("playbookId", '') AS "playbookId",
           count(*) FILTER (WHERE "decision" = 'buy') AS calls,
           count(*) FILTER (WHERE "decision" = 'buy' AND "hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE "decision" = 'buy' AND won = 1) AS won2x,
           count(*) FILTER (WHERE "decision" = 'buy' AND "hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE "decision" = 'buy' AND "disqualified") AS doubled_after_stop,
           sum(power("probability2x" - won, 2)) FILTER (WHERE "probability2x" IS NOT NULL AND "hit2xIn1h" IS NOT NULL) AS brier_sum,
           count(*) FILTER (WHERE "probability2x" IS NOT NULL AND "hit2xIn1h" IS NOT NULL) AS brier_n,
           sum(power("curatorProbability" - won, 2)) FILTER (WHERE "curatorProbability" IS NOT NULL AND "hit2xIn1h" IS NOT NULL) AS curator_brier_sum,
           count(*) FILTER (WHERE "curatorProbability" IS NOT NULL AND "hit2xIn1h" IS NOT NULL) AS curator_brier_n
    FROM graded
    GROUP BY 1
    ORDER BY 1`;

  // Every user's matches over the window, through Match's own (matchedAt) index: this used to
  // list every User id into an = ANY() just to reach the (userId, matchedAt) index, and that list
  // grew with the user base.
  const matchRows = (
    opts.includeFilterMatches === false ? Promise.resolve(false) : Promise.resolve(true)
  ).then((wanted) => {
    if (!wanted) return [];
    // A match is anchored a moment after it is created (anchorMatchOutcome), so an unanchored one
    // only counts as ungradable once it is older than that gap could plausibly be. One whose
    // anchor row closed with no price inside the win window (an outage) is ungradable too, for as
    // long as that row exists to say so; Match carries no closing time of its own.
    return prisma.$queryRaw<(RawCounts & { filterId: string; name: string; ungradable: bigint })[]>`
      SELECT m."filterId" AS "filterId",
             f."name" AS name,
             count(*) AS calls,
             count(*) FILTER (WHERE m."hit2xIn1h" IS NOT NULL) AS graded,
             count(*) FILTER (WHERE m."hit2xIn1h" AND NOT COALESCE(m."disqualified", false)) AS won2x,
             count(*) FILTER (WHERE m."hit4xIn1h") AS won4x,
             count(*) FILTER (WHERE m."disqualified") AS doubled_after_stop,
             count(*) FILTER (WHERE m."hit2xIn1h" IS NULL
                                AND ((m."candidateOutcomeId" IS NULL
                                      AND m."matchedAt" < now() - interval '10 minutes')
                                  OR EXISTS (SELECT 1 FROM "CandidateOutcome" o
                                              WHERE o."id" = m."candidateOutcomeId"
                                                AND o."finalized24hAt" IS NOT NULL
                                                AND o."finalizedAt" IS NULL))) AS ungradable
      FROM "Match" m
      JOIN "UserFilter" f ON f."id" = m."filterId"
      WHERE m."matchedAt" >= ${since} AND m."matchedAt" < ${until}
      GROUP BY 1, 2`;
  });

  // Every sampled moment by kind. "event" rows are the population curators choose from, so their
  // rate is the base a pick has to beat; "match" rows are filter alerts deduplicated per token.
  const sampleRows = prisma.$queryRaw<(RawCounts & { kind: string })[]>`
    SELECT co."sampleKind" AS kind,
           count(*) AS calls,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE co."disqualified") AS doubled_after_stop
    FROM "CandidateOutcome" co
    WHERE co."anchorAt" >= ${since} AND co."anchorAt" < ${until}
      -- Graded "match" rows are deleted MATCH_OUTCOME_RETENTION_DAYS after their watch ends
      -- (cleanupJob) while ungraded ones stay, so over a longer window that kind would read as
      -- mostly pending. Its row covers only the days its graded rows still exist.
      AND (co."sampleKind" <> 'match'
           OR co."anchorAt" >= now() - make_interval(days => ${env.MATCH_OUTCOME_RETENTION_DAYS}::int))
    GROUP BY 1
    ORDER BY 1`;

  // How far clean winners ran after the call: each one stays on the 24h watch once it wins, and
  // its run peak (the highest price over the watch, on the alert price) and when it came are recorded.
  // Curated alerts are the feed's own calls; samples are the training population.
  const winnerRunRows = prisma.$queryRaw<WinnerRunRow[]>`
    WITH winners AS (
      SELECT 'curated' AS population,
             COALESCE(a."peak24hReturnPct", co."peak24hReturnPct") AS peak,
             COALESCE(a."runPeakMinutes", co."runPeakMinutes") AS minutes,
             (a."outcomeFinalizedAt" IS NOT NULL OR co."finalized24hAt" IS NOT NULL) AS done
      FROM "CuratedAlert" a
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until}
        AND COALESCE(a."hit2xIn1h", co."hit2xIn1h")
        AND NOT COALESCE(a."disqualified", co."disqualified", false)
      UNION ALL
      SELECT 'samples', co."peak24hReturnPct", co."runPeakMinutes", co."finalized24hAt" IS NOT NULL
      FROM "CandidateOutcome" co
      WHERE co."anchorAt" >= ${since} AND co."anchorAt" < ${until}
        AND co."sampleKind" IN ('hourly', 'event')
        AND co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)
    )
    SELECT population,
           count(*) AS winners,
           count(*) FILTER (WHERE done AND peak IS NOT NULL) AS finished,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY 1 + peak / 100)
             FILTER (WHERE done AND peak IS NOT NULL) AS median_multiple,
           max(1 + peak / 100) FILTER (WHERE done AND peak IS NOT NULL) AS best_multiple,
           count(*) FILTER (WHERE done AND peak >= 300) AS reached_4x,
           count(*) FILTER (WHERE done AND peak >= 900) AS reached_10x,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)
             FILTER (WHERE done AND minutes IS NOT NULL) AS median_minutes
    FROM winners
    GROUP BY population
    ORDER BY population`;

  const [
    curated,
    byModel,
    shadow,
    confidence,
    ai,
    aiProbability,
    aiPlaybooks,
    matches,
    samples,
    byTier,
    continuity,
    winnerRuns,
  ] = await Promise.all([
    curatedRows,
    modelRows,
    shadowRows,
    confidenceRows,
    aiRows,
    aiProbabilityRows,
    aiPlaybookRows,
    matchRows,
    sampleRows,
    tierRows,
    continuityRows,
    winnerRunRows,
  ]);

  const rated = (c: GradedCounts, min?: number) => withRates(c, targets, min);

  const curatedCounts = curated.map((r) => ({ source: r.source, ...toCounts(r) }));
  const shadowCounts = shadow.map((r) => ({ source: r.source, ...toCounts(r) }));
  const aiCounts = ai.map((r) => ({ mode: r.mode, decision: r.decision, ...toCounts(r) }));
  const buys = sumCounts(aiCounts.filter((r) => r.decision === "buy"));
  const allReviewed = sumCounts(aiCounts.filter((r) => r.decision !== "error"));
  const brierOf = (sum: number | null, n: bigint) =>
    Number(n) > 0 && sum !== null ? Math.round((Number(sum) / Number(n)) * 1000) / 1000 : null;
  const sumBy = (key: "brier_sum" | "curator_brier_sum") =>
    aiPlaybooks.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  const countBy = (key: "brier_n" | "curator_brier_n") =>
    aiPlaybooks.reduce((acc, r) => acc + r[key], BigInt(0));
  const buyRates = rated(buys, env.AI_REVIEW_MIN_GRADED_BUYS);
  const allRates = rated(allReviewed);

  // Per filter, largest first and capped so one heavy user can't bloat the reply.
  const byFilter = new Map<string, { name: string; all: GradedCounts[] }>();
  for (const r of matches) {
    const entry = byFilter.get(r.filterId) ?? { name: r.name, all: [] };
    entry.all.push({ ...toCounts(r), ungradable: Number(r.ungradable) });
    byFilter.set(r.filterId, entry);
  }
  const filterList = [...byFilter.entries()]
    .map(([filterId, f]) => ({
      filterId,
      name: f.name,
      ...rated(sumCounts(f.all)),
    }))
    .sort((a, b) => b.graded - a.graded || b.calls - a.calls);
  const allMatchCounts = matches.map((r) => ({ ...toCounts(r), ungradable: Number(r.ungradable) }));

  return {
    window: { since, until },
    rules: {
      win: `2x on the alert price within ${WIN_WINDOW_MINUTES} minutes of the alert, without first falling 50% below it`,
      goal: `4x on the alert price within ${GOAL_WINDOW_MINUTES} minutes of the alert, same stop`,
      windowsNote:
        "The windows were 1 hour each until 2026-10-05; older calls were re-graded under the current windows from their recorded price path.",
      runPeak: `clean winners stay watched for ${CANDIDATE_EXTENDED_WATCH_HOURS}h to record how far they ran (winnerRuns)`,
      fill: "the price the token was detected and alerted at (no delay, no slippage)",
      note: "From 2026-10-03 to 2026-10-05 calls were graded from a fill a minute later plus slippage; those were re-graded from the alert price.",
      exitPlan: describeExitPlan(),
    },
    targets,
    minGradedForVerdict: MIN_GRADED_FOR_VERDICT,
    curatedAlerts: {
      total: rated(sumCounts(curatedCounts)),
      bySource: curatedCounts.map((r) => ({ ...r, ...rated(r) })),
      byModel: byModel.map((r) => {
        const counts = toCounts(r);
        return { model: r.model, ...counts, ...rated(counts) };
      }),
      byTier: byTier.map((r) => {
        const counts = toCounts(r);
        return { tier: r.tier, ...counts, ...rated(counts) };
      }),
    },
    shadowEmissions: {
      total: rated(sumCounts(shadowCounts)),
      bySource: shadowCounts.map((r) => ({ ...r, ...rated(r) })),
    },
    // Live and shadow calls together, bucketed by curator confidence (0-100, bands of 10).
    curatorConfidenceBands: confidence.map((r) => ({ side: r.side, band: r.band, ...rated(toCounts(r)) })),
    aiReviewer: {
      mode: env.AI_REVIEW_MODE,
      // Gate mode needs AI_REVIEW_MIN_GRADED_BUYS graded buys meeting both targets.
      buys: buyRates,
      allReviewed: allRates,
      // What the reviewer adds: its buys' 2x rate over the rate of every pick it reviewed, in points.
      liftPts:
        buyRates.hitRate2xPct !== null && allRates.hitRate2xPct !== null
          ? Math.round((buyRates.hitRate2xPct - allRates.hitRate2xPct) * 10) / 10
          : null,
      brier: brierOf(sumBy("brier_sum"), countBy("brier_n")),
      curatorBrier: brierOf(sumBy("curator_brier_sum"), countBy("curator_brier_n")),
      byPlaybook: aiPlaybooks.map((r) => ({
        playbookId: r.playbookId === "" ? null : r.playbookId,
        buys: rated(toCounts(r)),
        brier: brierOf(r.brier_sum, r.brier_n),
        curatorBrier: brierOf(r.curator_brier_sum, r.curator_brier_n),
      })),
      byDecision: aiCounts.map((r) => ({ ...r, ...rated(r) })),
      probability2xBands: aiProbability.map((r) => ({ band: r.band, ...rated(toCounts(r)) })),
    },
    filterMatches: {
      total: rated(sumCounts(allMatchCounts)),
      filterCount: filterList.length,
      byFilter: filterList.slice(0, 50),
    },
    winnerRuns: winnerRuns.map(toWinnerRuns),
    samples: {
      byKind: samples.map((r) => ({ kind: r.kind, ...rated(toCounts(r)) })),
      // When the newest hourly/event sample was banked and how many landed in the last hour: the
      // continuity check (null newest = nothing in a week).
      newestAnchorAt: continuity[0]?.newest ?? null,
      lastHourRows: Number(continuity[0]?.last_hour ?? 0),
    },
  };
}

/** Tables the worker reads and writes on every cycle. */
const HOT_TABLES = ["Token", "TokenSnapshot", "Match", "CandidateOutcome", "RugCheckCache", "UserFilter"];

/** Exported for the route test. Read-only catalog queries - cheap whatever the table sizes. */
export async function buildDbReport() {
  const [activity, tables, indexes, locks] = await Promise.all([
    prisma.$queryRaw<
      {
        pid: number;
        state: string | null;
        wait_event_type: string | null;
        wait_event: string | null;
        running_ms: number | null;
        query: string | null;
      }[]
    >`
      SELECT pid, state, wait_event_type, wait_event,
             (EXTRACT(EPOCH FROM (now() - query_start)) * 1000)::float8 AS running_ms,
             LEFT(query, 400) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'
      ORDER BY query_start ASC NULLS LAST
      LIMIT 40`,
    prisma.$queryRaw<
      {
        table: string;
        live_rows: bigint;
        dead_rows: bigint;
        total_bytes: bigint;
        seq_scans: bigint;
        idx_scans: bigint | null;
        last_autovacuum: Date | null;
        last_autoanalyze: Date | null;
      }[]
    >`
      SELECT relname AS table, n_live_tup AS live_rows, n_dead_tup AS dead_rows,
             pg_total_relation_size(relid) AS total_bytes, seq_scan AS seq_scans,
             idx_scan AS idx_scans, last_autovacuum, last_autoanalyze
      FROM pg_stat_user_tables
      WHERE relname = ANY(${HOT_TABLES})
      ORDER BY pg_total_relation_size(relid) DESC`,
    prisma.$queryRaw<{ table: string; index: string; valid: boolean; bytes: bigint; scans: bigint }[]>`
      SELECT t.relname AS table, i.relname AS index, x.indisvalid AS valid,
             pg_relation_size(i.oid) AS bytes, COALESCE(s.idx_scan, 0) AS scans
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
      WHERE t.relname = ANY(${HOT_TABLES})
      ORDER BY t.relname, i.relname`,
    prisma.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted`,
  ]);
  return {
    activity,
    tables: tables.map((t) => ({
      ...t,
      live_rows: Number(t.live_rows),
      dead_rows: Number(t.dead_rows),
      total_mb: Math.round(Number(t.total_bytes) / 1_048_576),
      total_bytes: undefined,
      seq_scans: Number(t.seq_scans),
      idx_scans: t.idx_scans === null ? null : Number(t.idx_scans),
    })),
    indexes: indexes.map((i) => ({
      ...i,
      mb: Math.round(Number(i.bytes) / 1_048_576),
      bytes: undefined,
      scans: Number(i.scans),
    })),
    locksWaiting: Number(locks[0]?.waiting ?? 0),
  };
}

const mb = (bytes: bigint | number | null) => Math.round((Number(bytes ?? 0) / 1_048_576) * 10) / 10;

/**
 * Exported for the route test. Everything but the Token class count and the snapshot sample
 * reads the catalog or an indexed range; those two are a single pass over Token (no index serves
 * "never traded") and a 1% block sample of TokenSnapshot.
 */
export async function buildStorageReport() {
  const [db, tables, daily, outcomes, tokenClasses, snapshotSample] = await Promise.all([
    prisma.$queryRaw<{ bytes: bigint; stats_reset: Date | null }[]>`
      SELECT pg_database_size(current_database()) AS bytes, stats_reset
      FROM pg_stat_database WHERE datname = current_database()`,
    prisma.$queryRaw<
      {
        table: string;
        live_rows: bigint;
        dead_rows: bigint;
        inserted: bigint;
        deleted: bigint;
        heap: bigint;
        indexes: bigint;
        total: bigint;
      }[]
    >`
      SELECT relname AS table, n_live_tup AS live_rows, n_dead_tup AS dead_rows,
             n_tup_ins AS inserted, n_tup_del AS deleted,
             pg_relation_size(relid) AS heap, pg_indexes_size(relid) AS indexes,
             pg_total_relation_size(relid) AS total
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC`,
    // A week of new rows per day, each through an index on its own timestamp.
    prisma.$queryRaw<{ day: Date; table: string; rows: bigint }[]>`
      SELECT date_trunc('day', "firstSeenAt") AS day, 'Token' AS table, count(*) AS rows
        FROM "Token" WHERE "firstSeenAt" >= date_trunc('day', now()) - interval '7 days' GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', "createdAt"), 'CuratedAlert', count(*)
        FROM "CuratedAlert" WHERE "createdAt" >= date_trunc('day', now()) - interval '7 days' GROUP BY 1
      ORDER BY 2, 1`,
    prisma.$queryRaw<{ day: Date; kind: string; rows: bigint; avg_features_bytes: number | null }[]>`
      SELECT date_trunc('day', "anchorAt") AS day, "sampleKind" AS kind, count(*) AS rows,
             avg(pg_column_size("features"))::float8 AS avg_features_bytes
      FROM "CandidateOutcome"
      WHERE "anchorAt" >= date_trunc('day', now()) - interval '7 days'
      GROUP BY 1, 2 ORDER BY 1, 2`,
    prisma.$queryRaw<
      { never_live: bigint; live_never_in_band: bigint; in_band: bigint; older_than_3d: bigint }[]
    >`
      SELECT count(*) FILTER (WHERE "lastLiveAt" IS NULL AND "firstInBandAt" IS NULL) AS never_live,
             count(*) FILTER (WHERE "lastLiveAt" IS NOT NULL AND "firstInBandAt" IS NULL) AS live_never_in_band,
             count(*) FILTER (WHERE "firstInBandAt" IS NOT NULL) AS in_band,
             count(*) FILTER (WHERE "firstSeenAt" < now() - interval '3 days') AS older_than_3d
      FROM "Token"`,
    // "Mattered" = anything the training set, the alert feeds or the grading still points at.
    prisma.$queryRaw<{ age: string; source: string; mattered: boolean; rows: bigint; avg_bytes: number }[]>`
      SELECT CASE WHEN s."takenAt" > now() - interval '1 day' THEN '0-1d'
                  WHEN s."takenAt" > now() - interval '2 days' THEN '1-2d'
                  WHEN s."takenAt" > now() - interval '7 days' THEN '2-7d'
                  WHEN s."takenAt" > now() - interval '30 days' THEN '7-30d'
                  ELSE '30d+' END AS age,
             s."source" AS source,
             (EXISTS (SELECT 1 FROM "CandidateOutcome" c WHERE c."tokenId" = s."tokenId")
              OR EXISTS (SELECT 1 FROM "Match" m WHERE m."tokenId" = s."tokenId")
              OR EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."tokenId" = s."tokenId")) AS mattered,
             count(*) AS rows,
             avg(pg_column_size(s.*))::float8 AS avg_bytes
      FROM "TokenSnapshot" s TABLESAMPLE SYSTEM (1)
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  ]);
  const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
  return {
    databaseMb: mb(db[0]?.bytes ?? 0),
    statsResetAt: db[0]?.stats_reset ?? null,
    tables: tables.map((t) => ({
      table: t.table,
      liveRows: n(t.live_rows),
      deadRows: n(t.dead_rows),
      insertedSinceReset: n(t.inserted),
      deletedSinceReset: n(t.deleted),
      heapMb: mb(t.heap),
      toastMb: mb(Number(t.total) - Number(t.heap) - Number(t.indexes)),
      indexMb: mb(t.indexes),
      totalMb: mb(t.total),
    })),
    dailyRows: daily.map((d) => ({ day: d.day, table: d.table, rows: n(d.rows) })),
    candidateOutcomesDaily: outcomes.map((o) => ({
      day: o.day,
      kind: o.kind,
      rows: n(o.rows),
      avgFeaturesBytes: o.avg_features_bytes === null ? null : Math.round(o.avg_features_bytes),
    })),
    tokens: {
      neverLive: n(tokenClasses[0]?.never_live),
      liveNeverInBand: n(tokenClasses[0]?.live_never_in_band),
      inBand: n(tokenClasses[0]?.in_band),
      olderThan3d: n(tokenClasses[0]?.older_than_3d),
    },
    // A 1% block sample: multiply rows by ~100 for the table-wide estimate.
    snapshotSample: snapshotSample.map((s) => ({
      age: s.age,
      source: s.source,
      mattered: s.mattered,
      rows: n(s.rows),
      avgBytes: Math.round(s.avg_bytes),
    })),
  };
}
