import { z } from "zod";
import {
  describeExitPlan,
  MAX_EVENT_AGE_MINUTES,
  MIN_BUY_RATIO,
  prisma,
  Prisma,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_SNIPER_WALLET_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  walletSafetyCutsSql,
  SAFETY_MAX_FRESH_WALLET_PCT,
  type Env,
} from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";
import {
  counts,
  sortedTallies,
  tally,
  tokenSageWorkerStatus,
  topCategory,
  type AlertOutcomeRow,
  type OutcomeTally,
} from "./routes/adminInsights.js";

/**
 * The Market Lighthouse on the Live tab: how the tokens that pass the pre-checks did, and what
 * TokenSage sees across new coins (the same stored answers as the Admin tab's TokenSage section).
 * Aggregates only - no token names, mints, referent labels, summaries or failure reasons - so
 * subscribers and guests read one answer, and a guest learns nothing about a live coin before
 * their feed's delay runs out.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Aggregates over a day or more of rows: one fill per window, however many tabs open the modal. */
const CACHE_MS = 5 * 60_000;
/**
 * How long past CACHE_MS an answer may still be served while its refill runs. keepWarm() normally
 * refills well inside CACHE_MS; this only covers a refill that is slow or failing, and past it a
 * reader waits rather than read something older.
 */
const STALE_MS = 60 * 60_000;

export const LIGHTHOUSE_WINDOWS = [1, 7] as const;
export const lighthouseQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (LIGHTHOUSE_WINDOWS as readonly number[]).includes(d), {
      message: `days must be one of ${LIGHTHOUSE_WINDOWS.join(", ")}`,
    })
    .default(1),
  /**
   * The reader's IANA zone, for the hour-of-day chart (screenedByHourOfDay). Canonicalized, so
   * "europe/berlin" and "Europe/Berlin" share one cache. Absent means UTC, and so does a zone
   * this server's ICU doesn't know ("Etc/Unknown", which Chrome reports when it can't tell, or
   * a zone newer than our tzdata): the answer says UTC and the web shifts by today's offset, rather
   * than the whole Lighthouse failing over a hint for one chart.
   */
  tz: z
    .string()
    .max(64)
    .transform((tz) => canonicalTimeZone(tz) ?? "UTC")
    .default("UTC"),
});

function canonicalTimeZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Windows "Signals at a glance" can be read over. A day and a week are parts of the full answer
 * above, so they come from its cache; the month has a cache of its own holding just the signals,
 * since the full answer's dozen aggregates over a month of reads would cost far more than these.
 */
export const SIGNAL_WINDOWS = [1, 7, 30] as const;
export const lighthouseSignalsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (SIGNAL_WINDOWS as readonly number[]).includes(d), {
      message: `days must be one of ${SIGNAL_WINDOWS.join(", ")}`,
    })
    .default(1),
});

/** The tide chart's buckets: hourly over a day, six-hourly over a week (28 bars either way, give or take). */
const bucketHoursFor = (days: number) => (days <= 1 ? 1 : 6);

/** Top-level categories drawn in the tide; the rest fold into "other" so no hue is ever generated. */
const TIDE_SERIES = 5;

export interface LighthouseTally {
  label: string;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  /** Calls whose 10x verdict is in: the 10x rate's denominator. */
  tenXGraded: number;
  /** Calls with a simulated return under the exit plan, and their sum (percent). */
  returnN: number;
  returnSum: number;
}

const slimTally = (t: OutcomeTally): LighthouseTally => ({
  label: t.label,
  alerts: t.alerts,
  graded: t.graded,
  won2x: t.won2x,
  won4x: t.won4x,
  won10x: t.won10x,
  tenXGraded: t.tenXGraded,
  returnN: t.returnN,
  returnSum: t.returnSum,
});

interface ScreenedRow {
  bucket: Date;
  calls: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  sim_calls: bigint;
  sim_sum: number | null;
}

/** The screened buckets: 3-hourly over a day, daily over a week. */
const screenedBucketHoursFor = (days: number) => (days <= 1 ? 3 : 24);

const rate = (won: number, of: number) => (of > 0 ? (won / of) * 100 : null);

/**
 * How every token that passed the pre-checks did from its decision moment: the "event" rows, the
 * moments the curators decide at, which are only banked for tokens that passed the safety screen
 * and the event pre-gate. Counted the way the stats route counts them (a 2x after the stop is a
 * loss), and the return is the fixed exit plan's, not the peak, so outliers don't run the average.
 */
async function buildScreenedOutcomes(env: Env, since: Date, days: number) {
  const bucketHours = screenedBucketHoursFor(days);
  const bucketSeconds = bucketHours * 3600;
  const rows = await prisma.$queryRaw<ScreenedRow[]>`
    SELECT to_timestamp(floor(extract(epoch FROM co."anchorAt") / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
           count(*) AS calls,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE co."hit10xIn1h") AS won10x,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL
                              AND (co."hit10xIn1h" IS NOT NULL OR NOT (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)))) AS ten_x_graded,
           count(co."simReturnPct") AS sim_calls,
           sum(co."simReturnPct")::float8 AS sim_sum
    FROM "CandidateOutcome" co
    WHERE co."sampleKind" = 'event' AND co."anchorAt" > ${since}
      AND ${walletSafetyCutsSql(Prisma.raw('co."features"'))}
    GROUP BY 1 ORDER BY 1`;
  const n = (v: bigint | number | null) => Number(v ?? 0);
  const total = { calls: 0, graded: 0, won2x: 0, won4x: 0, won10x: 0, tenXGraded: 0, simCalls: 0, simSum: 0 };
  const byBucket = rows.map((r) => {
    const b = {
      calls: n(r.calls),
      graded: n(r.graded),
      won2x: n(r.won2x),
      won4x: n(r.won4x),
      won10x: n(r.won10x),
      tenXGraded: n(r.ten_x_graded),
      simCalls: n(r.sim_calls),
      simSum: r.sim_sum ?? 0,
    };
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += b[k];
    return {
      at: r.bucket.toISOString(),
      graded: b.graded,
      hit2xPct: rate(b.won2x, b.graded),
      hit4xPct: rate(b.won4x, b.graded),
      hit10xPct: rate(b.won10x, b.tenXGraded),
      avgReturnPct: b.simCalls > 0 ? b.simSum / b.simCalls : null,
    };
  });
  return {
    bucketHours,
    calls: total.calls,
    graded: total.graded,
    hit2xPct: rate(total.won2x, total.graded),
    hit4xPct: rate(total.won4x, total.graded),
    hit10xPct: rate(total.won10x, total.tenXGraded),
    tenXGraded: total.tenXGraded,
    avgReturnPct: total.simCalls > 0 ? total.simSum / total.simCalls : null,
    returnGraded: total.simCalls,
    exitPlan: describeExitPlan(),
    byBucket,
    // What a token has to clear to count here, for the dashboard's explainer.
    checks: {
      freshWalletMaxPct: SAFETY_MAX_FRESH_WALLET_PCT,
      emptyWalletRejectPct: SAFETY_REJECT_EMPTY_WALLET_PCT,
      sniperWalletRejectPct: SAFETY_REJECT_SNIPER_WALLET_PCT,
      top10HolderRejectPct: SAFETY_REJECT_TOP10_HOLDER_PCT,
      mcapMinUsd: env.MCAP_FILTER_MIN,
      mcapMaxUsd: env.MCAP_FILTER_MAX,
      maxAgeMinutes: MAX_EVENT_AGE_MINUTES,
      minBuySharePct: Math.round(MIN_BUY_RATIO * 100),
    },
  };
}

interface ScreenedHourRow {
  hour: Date;
  calls: number;
  graded: number;
  won2x: number;
  return_n: number;
  return_sum: number;
}

/**
 * Every hour the hourly rollup (LighthouseHour, apps/worker/src/jobs/lighthouseRollupJob.ts)
 * saw anything screened in, oldest first: one row per hour, read once for every reader's zone.
 */
function screenedHours() {
  return prisma.$queryRaw<ScreenedHourRow[]>`
    SELECT h."hour", h."screenedCalls" AS calls, h."screenedGraded" AS graded, h."screenedWon2x" AS won2x,
           h."screenedReturnN" AS return_n, h."screenedReturnSum"::float8 AS return_sum
    FROM "LighthouseHour" h
    WHERE h."screenedCalls" > 0
    ORDER BY h."hour"`;
}

/**
 * The screened field by hour of the day in `timeZone`, over everything the rollup has kept:
 * which hours launch the most decision-ready tokens and which hours' tokens pay. Always all 24
 * hours, zero where nothing was screened, so the chart's columns never shift.
 *
 * Each row goes on the hour its start falls on in the zone at its own date, so history from
 * the other side of a DST change lands on the right hour. In a half-hour zone that is the hour
 * the row starts in (00:00 UTC is 05:30 in Kolkata, hour 5). Done here with the same zone
 * database the browser names its zone from, not Postgres's, whose aliases differ.
 */
function screenedByHourOfDay(rows: ScreenedHourRow[], timeZone: string) {
  const localHour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
  const sums = Array.from({ length: 24 }, () => ({
    calls: 0,
    graded: 0,
    won2x: 0,
    returnN: 0,
    returnSum: 0,
  }));
  for (const r of rows) {
    const s = sums[Number(localHour.format(r.hour)) % 24]!;
    s.calls += r.calls;
    s.graded += r.graded;
    s.won2x += r.won2x;
    s.returnN += r.return_n;
    s.returnSum += r.return_sum;
  }
  const oldest = rows[0]?.hour;
  const newest = rows[rows.length - 1]?.hour;
  return {
    /** The zone the hours are in. */
    timeZone,
    /**
     * Days of hourly history behind the figures, from the first hour anything was screened
     * through the end of the last (0 before then).
     */
    days: oldest && newest ? Math.ceil((newest.getTime() - oldest.getTime() + HOUR_MS) / DAY_MS) : 0,
    hours: sums.map((s, hour) => ({
      hour,
      calls: s.calls,
      graded: s.graded,
      hit2xPct: rate(s.won2x, s.graded),
      avgReturnPct: s.returnN > 0 ? s.returnSum / s.returnN : null,
      returnGraded: s.returnN,
    })),
  };
}

/**
 * "Signals at a glance": what TokenSage said about each coin read in the window - its X link
 * check (deep reads only), whether its story is in the news, whether it copies a recent coin, and
 * what it trades against. Shared by the full window and the signals-only windows below.
 */
function signalQueries(since: Date) {
  return [
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "xVerdict" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND depth = 'full' AND status <> 'failed' AND "xVerdict" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT CASE WHEN "trendMatched" THEN 'in the news' ELSE 'not in the news' END AS label,
             count(*) AS count
      FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "trendMatched" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT CASE WHEN "copiesRecent" THEN 'copies a recent coin' ELSE 'original' END AS label,
             count(*) AS count
      FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "copiesRecent" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "pairKind" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "pairKind" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
  ] as const;
}

export async function buildMarketLighthouse(env: Env, days: number) {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const bucketHours = bucketHoursFor(days);
  const bucketSeconds = bucketHours * 3600;

  const [
    status,
    byDepthStatus,
    tideRows,
    topLevel,
    subCategories,
    referentSupport,
    flags,
    xVerdicts,
    news,
    copies,
    pairKinds,
    averages,
    alertRows,
    screened,
  ] = await Promise.all([
    tokenSageWorkerStatus(),
    prisma.tokenNarrative.groupBy({
      by: ["depth", "status"],
      where: { checkedAt: { gt: since } },
      _count: { _all: true },
    }),
    // Each described coin once, under the top-level part of its main category (else the one TokenSage is surest of).
    prisma.$queryRaw<{ bucket: Date; label: string | null; count: bigint }[]>`
      SELECT to_timestamp(floor(extract(epoch FROM n."checkedAt") / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
             -- COALESCE only runs the subquery when it needs it: most reads name a main category.
             split_part(COALESCE(n."mainCategory", (
               SELECT c->>'label'
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
               WHERE jsonb_typeof(c->'label') = 'string'
               ORDER BY CASE WHEN jsonb_typeof(c->'confidence') = 'number' THEN (c->>'confidence')::float8 END DESC NULLS LAST
               LIMIT 1
             )), '/', 1) AS label,
             count(*) AS count
      FROM "TokenNarrative" n
      WHERE n."checkedAt" > ${since} AND n.status <> 'failed'
      GROUP BY 1, 2`,
    // Coins carrying each label: each coin's labels made distinct on its own row (the mint is the
    // key), rather than count(DISTINCT mint), which sorted every label of the window by mint.
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT c.label, count(*) AS count
      FROM "TokenNarrative" n,
           LATERAL (
             SELECT DISTINCT split_part(e->>'label', '/', 1) AS label
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) e
           ) c
      WHERE n."checkedAt" > ${since} AND n.status <> 'failed'
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT c.label, count(*) AS count
      FROM "TokenNarrative" n,
           LATERAL (
             SELECT DISTINCT e->>'label' AS label
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) e
             WHERE position('/' IN e->>'label') > 0
           ) c
      WHERE n."checkedAt" > ${since} AND n.status <> 'failed'
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT s AS label, count(*) AS count FROM "TokenNarrative", unnest("referentSupport") s
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT f AS label, count(*) AS count FROM "TokenNarrative", unnest(flags) f
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    ...signalQueries(since),
    prisma.$queryRaw<{ referent_confidence: number | null; x_fit: number | null; newest: Date | null }[]>`
      SELECT avg("referentConfidence")::float8 AS referent_confidence, avg("xFit")::float8 AS x_fit,
             max("checkedAt") AS newest
      FROM "TokenNarrative" WHERE "checkedAt" > ${since} AND status <> 'failed'`,
    // Model alerts in the window with what TokenSage says about their coin now. Same bound and
    // cap as the Admin report; only the columns the tallies need, never the mint.
    prisma.$queryRaw<AlertOutcomeRow[]>`
      SELECT (a."hit2xIn1h" AND NOT COALESCE(a."disqualified", false)) AS hit2x, a."hit4xIn1h" AS hit4x, a."hit10xIn1h" AS hit10x,
             a."simReturnPct"::float8 AS sim_return,
             n.status, n.categories, n."mainCategory" AS main_category, n."xVerdict" AS x_verdict, n."copiesRecent" AS copies_recent,
             CASE WHEN n."referentGeneric" THEN n."referentKind" || ' (kind only)' ELSE n."referentKind" END AS referent_kind, n.flags
      FROM "CuratedAlert" a
      JOIN "Token" t ON t.id = a."tokenId"
      LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
      WHERE a."createdAt" > ${since}
      ORDER BY a."createdAt" DESC
      LIMIT 20000`,
    buildScreenedOutcomes(env, since, days),
  ]);

  // ---- Reads ----
  let total = 0;
  let failed = 0;
  let deep = 0;
  for (const g of byDepthStatus) {
    total += g._count._all;
    if (g.status === "failed") failed += g._count._all;
    else if (g.depth === "full") deep += g._count._all;
  }
  const described = total - failed;

  // ---- Tide: zero-filled buckets, the biggest categories each their own series ----
  const firstBucket = Math.floor(since.getTime() / 1000 / bucketSeconds) * bucketSeconds;
  const lastBucket = Math.floor(now / 1000 / bucketSeconds) * bucketSeconds;
  const buckets: number[] = [];
  for (let b = firstBucket; b <= lastBucket; b += bucketSeconds) buckets.push(b);
  const indexOf = new Map(buckets.map((b, i) => [b, i]));
  const totals = new Map<string, number>();
  for (const r of tideRows) {
    const label = r.label || "uncategorized";
    totals.set(label, (totals.get(label) ?? 0) + Number(r.count));
  }
  const named = [...totals.entries()]
    .filter(([label]) => label !== "uncategorized")
    .sort((a, b) => b[1] - a[1])
    .slice(0, TIDE_SERIES)
    .map(([label]) => label);
  const series = new Map<string, number[]>([...named, "other"].map((label) => [label, buckets.map(() => 0)]));
  for (const r of tideRows) {
    const i = indexOf.get(Math.floor(r.bucket.getTime() / 1000));
    if (i === undefined) continue;
    const label = r.label && named.includes(r.label) ? r.label : "other";
    series.get(label)![i]! += Number(r.count);
  }

  // ---- How the models' alerts did, by what TokenSage says about the coin ----
  const byCategory = new Map<string, OutcomeTally>();
  const byXVerdict = new Map<string, OutcomeTally>();
  const byCopy = new Map<string, OutcomeTally>();
  const all = new Map<string, OutcomeTally>();
  let alertsDescribed = 0;
  for (const row of alertRows) {
    tally(all, "all", row);
    if (row.status === null || row.status === "failed") continue;
    alertsDescribed += 1;
    tally(byCategory, topCategory(row.categories, row.main_category) ?? "uncategorized", row);
    if (row.x_verdict) tally(byXVerdict, row.x_verdict, row);
    if (row.copies_recent !== null)
      tally(byCopy, row.copies_recent ? "copies a recent coin" : "original", row);
  }
  const overall = all.get("all");

  const avg = averages[0];
  return {
    window: { days, since, bucketHours },
    tokenSage: { on: status.on, lastCycleAt: status.lastCycleAt },
    reads: {
      total,
      described,
      deep,
      quick: described - deep,
      failed,
      newestAt: avg?.newest ?? null,
    },
    avgReferentConfidence: avg?.referent_confidence ?? null,
    avgXFit: avg?.x_fit ?? null,
    tide: {
      buckets: buckets.map((b) => new Date(b * 1000).toISOString()),
      series: [...series.entries()]
        .map(([label, values]) => ({ label, values }))
        .filter((s) => s.label !== "other" || s.values.some((v) => v > 0)),
    },
    topLevelCategories: counts(topLevel),
    categories: counts(subCategories),
    referentSupport: counts(referentSupport),
    flags: counts(flags),
    xVerdicts: counts(xVerdicts),
    pairKinds: counts(pairKinds),
    copies: counts(copies),
    news: counts(news),
    screened,
    outcomes: {
      alerts: alertRows.length,
      described: alertsDescribed,
      graded: overall?.graded ?? 0,
      won2x: overall?.won2x ?? 0,
      won4x: overall?.won4x ?? 0,
      byCategory: sortedTallies(byCategory).map(slimTally),
      byXVerdict: sortedTallies(byXVerdict).map(slimTally),
      byCopy: sortedTallies(byCopy).map(slimTally),
    },
  };
}

/**
 * "Signals at a glance" alone, for a window the full answer doesn't cover: the four signal splits,
 * how many coins were read (deep reads decide whether the X and news checks can show at all), and
 * how calls did by narrative ("Which narratives pay" on the TokenSage page) and on originals
 * against copies.
 */
export async function buildLighthouseSignals(days: number): Promise<LighthouseSignals> {
  const since = new Date(Date.now() - days * DAY_MS);
  const [byDepthStatus, [xVerdicts, news, copies, pairKinds], alertRows] = await Promise.all([
    prisma.tokenNarrative.groupBy({
      by: ["depth"],
      where: { checkedAt: { gt: since }, status: { not: "failed" } },
      _count: { _all: true },
    }),
    Promise.all(signalQueries(since)),
    // Model alerts in the window with what TokenSage says about their coin now: only what the
    // narrative and copy tallies read. Same bound and cap as the full answer.
    prisma.$queryRaw<
      Pick<
        AlertOutcomeRow,
        | "hit2x"
        | "hit4x"
        | "hit10x"
        | "sim_return"
        | "status"
        | "categories"
        | "main_category"
        | "copies_recent"
      >[]
    >`
      SELECT (a."hit2xIn1h" AND NOT COALESCE(a."disqualified", false)) AS hit2x, a."hit4xIn1h" AS hit4x, a."hit10xIn1h" AS hit10x,
             a."simReturnPct"::float8 AS sim_return,
             n.status, n.categories, n."mainCategory" AS main_category, n."copiesRecent" AS copies_recent
      FROM "CuratedAlert" a
      JOIN "Token" t ON t.id = a."tokenId"
      LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
      WHERE a."createdAt" > ${since}
      ORDER BY a."createdAt" DESC
      LIMIT 20000`,
  ]);
  let described = 0;
  let deep = 0;
  for (const g of byDepthStatus) {
    described += g._count._all;
    if (g.depth === "full") deep += g._count._all;
  }
  const byCategory = new Map<string, OutcomeTally>();
  const byCopy = new Map<string, OutcomeTally>();
  const all = new Map<string, OutcomeTally>();
  let alertsDescribed = 0;
  for (const row of alertRows) {
    const full: AlertOutcomeRow = { ...row, x_verdict: null, referent_kind: null, flags: null };
    tally(all, "all", full);
    if (row.status === null || row.status === "failed") continue;
    alertsDescribed += 1;
    tally(byCategory, topCategory(row.categories, row.main_category) ?? "uncategorized", full);
    if (row.copies_recent !== null)
      tally(byCopy, row.copies_recent ? "copies a recent coin" : "original", full);
  }
  const overall = all.get("all");
  return {
    window: { days, since },
    reads: { described, deep },
    xVerdicts: counts(xVerdicts),
    news: counts(news),
    copies: counts(copies),
    pairKinds: counts(pairKinds),
    outcomes: {
      alerts: alertRows.length,
      described: alertsDescribed,
      graded: overall?.graded ?? 0,
      won2x: overall?.won2x ?? 0,
      byCategory: sortedTallies(byCategory).map(slimTally),
      byCopy: sortedTallies(byCopy).map(slimTally),
    },
  };
}

type WindowLighthouse = Awaited<ReturnType<typeof buildMarketLighthouse>>;
export interface LighthouseSignals {
  window: { days: number; since: Date };
  reads: { described: number; deep: number };
  xVerdicts: WindowLighthouse["xVerdicts"];
  news: WindowLighthouse["news"];
  copies: WindowLighthouse["copies"];
  pairKinds: WindowLighthouse["pairKinds"];
  outcomes: Pick<
    WindowLighthouse["outcomes"],
    "alerts" | "described" | "graded" | "won2x" | "byCategory" | "byCopy"
  >;
}

/** The signals part of a full window's answer, in the signals-only shape. */
const signalsOf = (m: WindowLighthouse): LighthouseSignals => ({
  window: { days: m.window.days, since: m.window.since },
  reads: { described: m.reads.described, deep: m.reads.deep },
  xVerdicts: m.xVerdicts,
  news: m.news,
  copies: m.copies,
  pairKinds: m.pairKinds,
  outcomes: {
    alerts: m.outcomes.alerts,
    described: m.outcomes.described,
    graded: m.outcomes.graded,
    won2x: m.outcomes.won2x,
    byCategory: m.outcomes.byCategory,
    byCopy: m.outcomes.byCopy,
  },
});
type ScreenedByHourOfDay = ReturnType<typeof screenedByHourOfDay>;
export type MarketLighthouse = Omit<WindowLighthouse, "screened"> & {
  screened: WindowLighthouse["screened"] & { byHourOfDay: ScreenedByHourOfDay };
};

/**
 * One cache per window, shared by the subscriber and guest routes, plus the hourly rows for the
 * hour-of-day chart and one cache per reader zone summing them: a new zone never refills the
 * window's aggregates or rereads the rows.
 *
 * A window's fill is a dozen aggregates over a week of reads and calls, several seconds in
 * production, so no reader should be the one waiting on it. keepWarm() refills each window as it
 * falls due (the API runs it every minute, routes/curated.ts), and past its five minutes an
 * answer is still served at once while a refill runs behind it (STALE_MS), so a reader only waits
 * on the very first fill after a start, which the startup warm-up has usually done already.
 */
export function createLighthouseCache() {
  const caches = new Map<number, SharedCache<WindowLighthouse>>();
  const hoursCache = new SharedCache<ScreenedHourRow[]>(CACHE_MS, { staleWhileRevalidateMs: STALE_MS });
  const hourCaches = new Map<string, SharedCache<ScreenedByHourOfDay>>();
  const windowCache = (days: number) => {
    let cache = caches.get(days);
    if (!cache) {
      cache = new SharedCache<WindowLighthouse>(CACHE_MS, { staleWhileRevalidateMs: STALE_MS });
      // Bounded by the schema: one per LIGHTHOUSE_WINDOWS.
      caches.set(days, cache);
    }
    return cache;
  };
  const signalCaches = new Map<number, SharedCache<LighthouseSignals>>();
  const signalCache = (days: number) => {
    let cache = signalCaches.get(days);
    if (!cache) {
      cache = new SharedCache<LighthouseSignals>(CACHE_MS, { staleWhileRevalidateMs: STALE_MS });
      // Bounded by the schema: one per SIGNAL_WINDOWS outside LIGHTHOUSE_WINDOWS.
      signalCaches.set(days, cache);
    }
    return cache;
  };
  const isFullWindow = (days: number) => (LIGHTHOUSE_WINDOWS as readonly number[]).includes(days);
  /** "Signals at a glance" for a window: a day or a week from the full answer's cache, else its own. */
  const signals = async (env: Env, days: number): Promise<LighthouseSignals> =>
    isFullWindow(days)
      ? signalsOf(await windowCache(days).get(() => buildMarketLighthouse(env, days)))
      : signalCache(days).get(() => buildLighthouseSignals(days));
  const read = async (env: Env, days: number, timeZone = "UTC"): Promise<MarketLighthouse> => {
    let hourCache = hourCaches.get(timeZone);
    if (!hourCache) {
      hourCache = new SharedCache<ScreenedByHourOfDay>(CACHE_MS, { staleWhileRevalidateMs: STALE_MS });
      // Bounded by the schema: canonical IANA zones only, a few hundred at most.
      hourCaches.set(timeZone, hourCache);
    }
    const [m, byHourOfDay] = await Promise.all([
      windowCache(days).get(() => buildMarketLighthouse(env, days)),
      hourCache.get(async () => screenedByHourOfDay(await hoursCache.get(screenedHours), timeZone)),
    ]);
    return { ...m, screened: { ...m.screened, byHourOfDay } };
  };
  /**
   * Starts a refill of every window, and of the hourly rows, whose answer is due or missing; a
   * fresh one, or one already filling, is left alone. One window at a time, so the refills never
   * hold more than one window's queries on the pool. Never rejects.
   */
  const keepWarm = async (env: Env): Promise<void> => {
    for (const days of LIGHTHOUSE_WINDOWS)
      await windowCache(days).warm(() => buildMarketLighthouse(env, days));
    await hoursCache.warm(screenedHours);
    for (const days of SIGNAL_WINDOWS)
      if (!isFullWindow(days)) await signalCache(days).warm(() => buildLighthouseSignals(days));
  };
  return Object.assign(read, { keepWarm, signals });
}
