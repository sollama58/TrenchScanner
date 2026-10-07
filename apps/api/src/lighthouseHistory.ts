import { z } from "zod";
import { describeExitPlan, prisma } from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";

/**
 * The Lighthouse tab's trends: the hourly sums the worker keeps for good (LighthouseHour,
 * LighthouseDayLabel - apps/worker/src/jobs/lighthouseRollupJob.ts), added up per hour, day or
 * week over a window of up to everything. Sums and counts, never rates: the tab computes every
 * rate itself, so one answer serves any chart a reader builds from it. Aggregates only, like the
 * Live tab's Lighthouse - no token is ever named - so guests read the same answer as subscribers.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Sums over at most a few thousand compact rows: one fill per window, however many tabs open. */
const CACHE_MS = 5 * 60_000;

/** Windows in days; 0 is everything kept. */
export const HISTORY_WINDOWS = [7, 30, 90, 365, 0] as const;
export const HISTORY_BUCKETS = ["hour", "day", "week"] as const;
export type HistoryBucket = (typeof HISTORY_BUCKETS)[number];
/** The breakdowns the rollup keeps per day (LABEL_DIMENSIONS in the worker's rollup job). */
export const HISTORY_DIMENSIONS = [
  "category",
  "subcategory",
  "flag",
  "referentKind",
  "referentSupport",
  "xVerdict",
  "pairKind",
  "copy",
  "news",
] as const;
export type HistoryDimension = (typeof HISTORY_DIMENSIONS)[number];

/** Hourly points past a month are too many to read; a year of days is fine. */
const MAX_HOURLY_DAYS = 30;
/** Labels drawn as their own series; the rest fold into "other", so no hue is ever generated. */
const TOP_LABELS = 5;

export const defaultBucketFor = (days: number): HistoryBucket =>
  days > 0 && days <= 7 ? "hour" : days > 0 && days <= 90 ? "day" : "week";

export const lighthouseHistoryQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .refine((d) => (HISTORY_WINDOWS as readonly number[]).includes(d), {
        message: `days must be one of ${HISTORY_WINDOWS.join(", ")} (0 is everything)`,
      })
      .default(30),
    bucket: z.enum(HISTORY_BUCKETS).optional(),
    dimension: z.enum(HISTORY_DIMENSIONS).default("category"),
  })
  .transform((q) => ({ ...q, bucket: q.bucket ?? defaultBucketFor(q.days) }))
  .refine((q) => q.bucket !== "hour" || (q.days > 0 && q.days <= MAX_HOURLY_DAYS), {
    message: `hourly buckets cover at most ${MAX_HOURLY_DAYS} days`,
  });
export type LighthouseHistoryQuery = z.infer<typeof lighthouseHistoryQuerySchema>;

interface SumRow {
  bucket: Date | null;
  screened_calls: bigint;
  screened_graded: bigint;
  screened_won2x: bigint;
  screened_won4x: bigint;
  screened_won10x: bigint;
  screened_ten_x_graded: bigint;
  screened_return_n: bigint;
  screened_return_sum: number | null;
  reads_total: bigint;
  reads_described: bigint;
  reads_deep: bigint;
  reads_failed: bigint;
  referent_confidence_sum: number | null;
  referent_confidence_n: bigint;
  x_fit_sum: number | null;
  x_fit_n: bigint;
  copies_recent: bigint;
  copies_answered: bigint;
  trend_matched: bigint;
  trend_answered: bigint;
  alerts: bigint;
  alerts_described: bigint;
  alerts_graded: bigint;
  alerts_won2x: bigint;
  alerts_won4x: bigint;
  alerts_won10x: bigint;
  alerts_ten_x_graded: bigint;
  alerts_return_n: bigint;
  alerts_return_sum: number | null;
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** One bucket's (or the whole window's) sums, as the tab reads them. */
function sums(r: SumRow | undefined) {
  return {
    screened: {
      calls: n(r?.screened_calls),
      graded: n(r?.screened_graded),
      won2x: n(r?.screened_won2x),
      won4x: n(r?.screened_won4x),
      won10x: n(r?.screened_won10x),
      tenXGraded: n(r?.screened_ten_x_graded),
      returnN: n(r?.screened_return_n),
      returnSum: r?.screened_return_sum ?? 0,
    },
    reads: {
      total: n(r?.reads_total),
      described: n(r?.reads_described),
      deep: n(r?.reads_deep),
      failed: n(r?.reads_failed),
      referentConfidenceSum: r?.referent_confidence_sum ?? 0,
      referentConfidenceN: n(r?.referent_confidence_n),
      xFitSum: r?.x_fit_sum ?? 0,
      xFitN: n(r?.x_fit_n),
      copiesRecent: n(r?.copies_recent),
      copiesAnswered: n(r?.copies_answered),
      trendMatched: n(r?.trend_matched),
      trendAnswered: n(r?.trend_answered),
    },
    alerts: {
      total: n(r?.alerts),
      described: n(r?.alerts_described),
      graded: n(r?.alerts_graded),
      won2x: n(r?.alerts_won2x),
      won4x: n(r?.alerts_won4x),
      won10x: n(r?.alerts_won10x),
      tenXGraded: n(r?.alerts_ten_x_graded),
      returnN: n(r?.alerts_return_n),
      returnSum: r?.alerts_return_sum ?? 0,
    },
  };
}
export type LighthouseSums = ReturnType<typeof sums>;

/**
 * The hours in [from, to) summed per `bucket` (or all together when null). date_trunc takes the
 * unit as text, so the bucket is a parameter, never spliced in.
 */
async function sumHours(from: Date | null, to: Date, bucket: HistoryBucket | null): Promise<SumRow[]> {
  const unit = bucket ?? "hour";
  const lower = from ?? new Date(0);
  return prisma.$queryRaw<SumRow[]>`
    SELECT CASE WHEN ${bucket !== null} THEN date_trunc(${unit}, h."hour") END AS bucket,
           sum(h."screenedCalls") AS screened_calls,
           sum(h."screenedGraded") AS screened_graded,
           sum(h."screenedWon2x") AS screened_won2x,
           sum(h."screenedWon4x") AS screened_won4x,
           sum(h."screenedWon10x") AS screened_won10x,
           sum(h."screenedTenXGraded") AS screened_ten_x_graded,
           sum(h."screenedReturnN") AS screened_return_n,
           sum(h."screenedReturnSum")::float8 AS screened_return_sum,
           sum(h."readsTotal") AS reads_total,
           sum(h."readsDescribed") AS reads_described,
           sum(h."readsDeep") AS reads_deep,
           sum(h."readsFailed") AS reads_failed,
           sum(h."referentConfidenceSum")::float8 AS referent_confidence_sum,
           sum(h."referentConfidenceN") AS referent_confidence_n,
           sum(h."xFitSum")::float8 AS x_fit_sum,
           sum(h."xFitN") AS x_fit_n,
           sum(h."copiesRecent") AS copies_recent,
           sum(h."copiesAnswered") AS copies_answered,
           sum(h."trendMatched") AS trend_matched,
           sum(h."trendAnswered") AS trend_answered,
           sum(h."alerts") AS alerts,
           sum(h."alertsDescribed") AS alerts_described,
           sum(h."alertsGraded") AS alerts_graded,
           sum(h."alertsWon2x") AS alerts_won2x,
           sum(h."alertsWon4x") AS alerts_won4x,
           sum(h."alertsWon10x") AS alerts_won10x,
           sum(h."alertsTenXGraded") AS alerts_ten_x_graded,
           sum(h."alertsReturnN") AS alerts_return_n,
           sum(h."alertsReturnSum")::float8 AS alerts_return_sum
    FROM "LighthouseHour" h
    WHERE h."hour" >= ${lower} AND h."hour" < ${to}
    GROUP BY 1 ORDER BY 1`;
}

interface LabelRow {
  bucket: Date;
  label: string;
  count: bigint;
  alerts: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
}

export interface LighthouseLabelTally {
  label: string;
  count: number;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  /** Calls whose 10x verdict is in: the 10x rate's denominator. */
  tenXGraded: number;
}

/** The start of the bucket holding `ms`: hours and days on the clock, weeks on Monday as date_trunc does. */
export function bucketStart(ms: number, bucket: HistoryBucket): number {
  if (bucket === "hour") return Math.floor(ms / HOUR_MS) * HOUR_MS;
  if (bucket === "day") return Math.floor(ms / DAY_MS) * DAY_MS;
  // 1970-01-01 was a Thursday; Monday came three days later.
  const MONDAY_OFFSET = 3 * DAY_MS;
  return Math.floor((ms + MONDAY_OFFSET) / WEEK_MS) * WEEK_MS - MONDAY_OFFSET;
}

const bucketMs = (bucket: HistoryBucket) =>
  bucket === "hour" ? HOUR_MS : bucket === "day" ? DAY_MS : WEEK_MS;

export async function buildLighthouseHistory(q: LighthouseHistoryQuery, now = new Date()) {
  const { days, bucket, dimension } = q;
  const to = new Date(bucketStart(now.getTime(), "hour") + HOUR_MS);
  const since = days > 0 ? new Date(bucketStart(now.getTime() - days * DAY_MS, bucket)) : null;
  // The label rows are daily, so an hourly view gets them per day.
  const labelBucket: HistoryBucket = bucket === "hour" ? "day" : bucket;
  const labelSince = since ? new Date(bucketStart(since.getTime(), labelBucket)) : null;

  const [coverage, perBucket, whole, previous, labelRows] = await Promise.all([
    prisma.lighthouseHour.aggregate({ _min: { hour: true }, _max: { hour: true } }),
    sumHours(since, to, bucket),
    sumHours(since, to, null),
    since ? sumHours(new Date(since.getTime() - days * DAY_MS), since, null) : Promise.resolve([]),
    prisma.$queryRaw<LabelRow[]>`
      SELECT date_trunc(${labelBucket}, l."day") AS bucket, l."label",
             sum(l."count") AS count, sum(l."alerts") AS alerts, sum(l."graded") AS graded,
             sum(l."won2x") AS won2x, sum(l."won4x") AS won4x, sum(l."won10x") AS won10x,
             sum(l."tenXGraded") AS ten_x_graded
      FROM "LighthouseDayLabel" l
      WHERE l."dimension" = ${dimension} AND l."day" >= ${labelSince ?? new Date(0)} AND l."day" < ${to}
      GROUP BY 1, 2`,
  ]);

  // Zero-filled buckets from the window's start (or the oldest hour kept) through now.
  const first = since ?? coverage._min.hour ?? to;
  const buckets: number[] = [];
  const step = bucketMs(bucket);
  for (let b = bucketStart(first.getTime(), bucket); b < to.getTime(); b += step) buckets.push(b);
  const byBucket = new Map(perBucket.filter((r) => r.bucket).map((r) => [r.bucket!.getTime(), r]));
  const series = buckets.map((b) => ({ at: new Date(b).toISOString(), ...sums(byBucket.get(b)) }));

  // Labels: the biggest few as their own series, the rest (and the unlabeled) as "other".
  const totals = new Map<string, number>();
  for (const r of labelRows) totals.set(r.label, (totals.get(r.label) ?? 0) + n(r.count));
  const top = [...totals.entries()]
    .filter(([label]) => label !== "uncategorized")
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LABELS)
    .map(([label]) => label);
  const labelBuckets = new Map<number, Map<string, LighthouseLabelTally>>();
  const labelStep = bucketMs(labelBucket);
  for (let b = bucketStart(first.getTime(), labelBucket); b < to.getTime(); b += labelStep) {
    labelBuckets.set(b, new Map());
  }
  for (const r of labelRows) {
    const rows = labelBuckets.get(r.bucket.getTime());
    if (!rows) continue;
    const label = top.includes(r.label) ? r.label : "other";
    let t = rows.get(label);
    if (!t) {
      t = { label, count: 0, alerts: 0, graded: 0, won2x: 0, won4x: 0, won10x: 0, tenXGraded: 0 };
      rows.set(label, t);
    }
    t.count += n(r.count);
    t.alerts += n(r.alerts);
    t.graded += n(r.graded);
    t.won2x += n(r.won2x);
    t.won4x += n(r.won4x);
    t.won10x += n(r.won10x);
    t.tenXGraded += n(r.ten_x_graded);
  }

  return {
    window: { days, since, bucket, dimension },
    coverage: { oldestHour: coverage._min.hour, newestHour: coverage._max.hour },
    exitPlan: describeExitPlan(),
    totals: sums(whole[0]),
    /** The same span just before the window; null when the window is everything. */
    previous: since ? sums(previous[0]) : null,
    series,
    labels: {
      dimension,
      bucket: labelBucket,
      top,
      buckets: [...labelBuckets.entries()].map(([b, rows]) => ({
        at: new Date(b).toISOString(),
        rows: [...rows.values()],
      })),
    },
  };
}

export type LighthouseHistory = Awaited<ReturnType<typeof buildLighthouseHistory>>;

/** One cache per window, bucket and dimension (bounded by the schema), shared by both routes. */
export function createLighthouseHistoryCache() {
  const caches = new Map<string, SharedCache<LighthouseHistory>>();
  return (q: LighthouseHistoryQuery) => {
    const key = `${q.days}:${q.bucket}:${q.dimension}`;
    let cache = caches.get(key);
    if (!cache) {
      cache = new SharedCache<LighthouseHistory>(CACHE_MS);
      caches.set(key, cache);
    }
    return cache.get(() => buildLighthouseHistory(q));
  };
}
