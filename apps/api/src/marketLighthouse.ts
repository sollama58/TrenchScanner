import { z } from "zod";
import {
  describeExitPlan,
  MAX_EVENT_AGE_MINUTES,
  MIN_BUY_RATIO,
  prisma,
  Prisma,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
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

export const LIGHTHOUSE_WINDOWS = [1, 7] as const;
export const lighthouseQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (LIGHTHOUSE_WINDOWS as readonly number[]).includes(d), {
      message: `days must be one of ${LIGHTHOUSE_WINDOWS.join(", ")}`,
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
      mcapMinUsd: env.MCAP_FILTER_MIN,
      mcapMaxUsd: env.MCAP_FILTER_MAX,
      maxAgeMinutes: MAX_EVENT_AGE_MINUTES,
      minBuySharePct: Math.round(MIN_BUY_RATIO * 100),
    },
  };
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
    referentKinds,
    referentSupport,
    flags,
    xVerdicts,
    pairKinds,
    copies,
    news,
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
    // Each described coin once, under the top-level part of the category TokenSage is surest of.
    prisma.$queryRaw<{ bucket: Date; label: string | null; count: bigint }[]>`
      SELECT to_timestamp(floor(extract(epoch FROM n."checkedAt") / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
             split_part(top.label, '/', 1) AS label,
             count(*) AS count
      FROM "TokenNarrative" n
      LEFT JOIN LATERAL (
        SELECT c->>'label' AS label
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
        WHERE jsonb_typeof(c->'label') = 'string'
        ORDER BY CASE WHEN jsonb_typeof(c->'confidence') = 'number' THEN (c->>'confidence')::float8 END DESC NULLS LAST
        LIMIT 1
      ) top ON true
      WHERE n."checkedAt" > ${since} AND n.status <> 'failed'
      GROUP BY 1, 2`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT split_part(c->>'label', '/', 1) AS label, count(DISTINCT n."mintAddress") AS count
      FROM "TokenNarrative" n,
           jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
      WHERE n."checkedAt" > ${since} AND n.status <> 'failed'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT c->>'label' AS label, count(DISTINCT n."mintAddress") AS count
      FROM "TokenNarrative" n,
           jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
      WHERE n."checkedAt" > ${since} AND n.status <> 'failed' AND position('/' IN c->>'label') > 0
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT CASE WHEN "referentGeneric" THEN "referentKind" || ' (kind only)' ELSE "referentKind" END AS label, count(*) AS count
      FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "referentKind" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT s AS label, count(*) AS count FROM "TokenNarrative", unnest("referentSupport") s
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT f AS label, count(*) AS count FROM "TokenNarrative", unnest(flags) f
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "xVerdict" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND depth = 'full' AND status <> 'failed' AND "xVerdict" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "pairKind" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "pairKind" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT CASE WHEN "copiesRecent" THEN 'copies a recent coin' ELSE 'original' END AS label,
             count(*) AS count
      FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "copiesRecent" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT CASE WHEN "trendMatched" THEN 'in the news' ELSE 'not in the news' END AS label,
             count(*) AS count
      FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' AND "trendMatched" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    // Reads where TokenSage resolved no referent at all (null kind) are counted, not labelled:
    // "(none)" is not a kind of thing a coin can be about.
    prisma.$queryRaw<
      { referent_confidence: number | null; x_fit: number | null; newest: Date | null; no_referent: bigint }[]
    >`
      SELECT avg("referentConfidence")::float8 AS referent_confidence, avg("xFit")::float8 AS x_fit,
             max("checkedAt") AS newest, count(*) FILTER (WHERE "referentKind" IS NULL) AS no_referent
      FROM "TokenNarrative" WHERE "checkedAt" > ${since} AND status <> 'failed'`,
    // Model alerts in the window with what TokenSage says about their coin now. Same bound and
    // cap as the Admin report; only the columns the tallies need, never the mint.
    prisma.$queryRaw<AlertOutcomeRow[]>`
      SELECT (a."hit2xIn1h" AND NOT COALESCE(a."disqualified", false)) AS hit2x, a."hit4xIn1h" AS hit4x, a."hit10xIn1h" AS hit10x,
             a."simReturnPct"::float8 AS sim_return,
             n.status, n.categories, n."xVerdict" AS x_verdict, n."copiesRecent" AS copies_recent,
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
    tally(byCategory, topCategory(row.categories) ?? "uncategorized", row);
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
      noReferent: Number(avg?.no_referent ?? 0),
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
    referentKinds: counts(referentKinds),
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

export type MarketLighthouse = Awaited<ReturnType<typeof buildMarketLighthouse>>;

/** One cache per window, shared by the subscriber and guest routes. */
export function createLighthouseCache() {
  const caches = new Map<number, SharedCache<MarketLighthouse>>();
  return (env: Env, days: number) => {
    let cache = caches.get(days);
    if (!cache) {
      cache = new SharedCache<MarketLighthouse>(CACHE_MS);
      // Bounded by the schema: one per LIGHTHOUSE_WINDOWS.
      caches.set(days, cache);
    }
    return cache.get(() => buildMarketLighthouse(env, days));
  };
}
