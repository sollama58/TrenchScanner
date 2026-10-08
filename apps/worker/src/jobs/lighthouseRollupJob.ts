import { prisma, createLogger, walletSafetyCutsSql, Prisma } from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("lighthouse-rollup");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The Market Lighthouse's history. The Live tab's Lighthouse (apps/api/src/marketLighthouse.ts)
 * sums the last day or week straight from CandidateOutcome, TokenNarrative and CuratedAlert, and
 * two of those are swept after weeks (CANDIDATE_OUTCOME_RETENTION_DAYS; the RPC-cache horizon in
 * cleanupJob.ts). This job folds the same sums into LighthouseHour (one row an hour) and
 * LighthouseDayLabel (one row per label and day), which nothing deletes, so the Lighthouse tab
 * can draw trends over months from a few hundred bytes an hour.
 *
 * Every run recomputes the trailing RECOMPUTE_HOURS, because recent hours keep moving: a decision
 * moment grades up to an hour after its anchor, a coin's TokenNarrative row moves to the hour of
 * its newest read, and a model's call grades over its first hour. Older hours are frozen as they
 * were last summed. The first run (an empty table) backfills from the oldest row still present,
 * and a run after a gap resumes from the last hour written, so no hour is ever skipped.
 *
 * Aggregates only: no mint, name, referent or summary leaves the source tables.
 */

/** Hours re-summed on every run, so late grades and re-reads land. */
export const RECOMPUTE_HOURS = 72;

/** The label breakdowns kept per day; LighthouseDayLabel.dimension takes these values. */
export const LABEL_DIMENSIONS = [
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
export type LabelDimension = (typeof LABEL_DIMENSIONS)[number];

export interface LighthouseRollupOptions {
  /** Sum from here instead of the trailing window or the backfill start (tests). */
  from?: Date;
  /** "Now" (tests). */
  now?: Date;
}

type HourRow = Omit<Prisma.LighthouseHourCreateInput, "hour" | "computedAt">;

const floorHour = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
const floorDay = (ms: number) => new Date(Math.floor(ms / DAY_MS) * DAY_MS);
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

const emptyHour = (): HourRow => ({
  screenedCalls: 0,
  screenedGraded: 0,
  screenedWon2x: 0,
  screenedWon4x: 0,
  screenedWon10x: 0,
  screenedTenXGraded: 0,
  screenedReturnN: 0,
  screenedReturnSum: 0,
  readsTotal: 0,
  readsDescribed: 0,
  readsDeep: 0,
  readsFailed: 0,
  referentConfidenceSum: 0,
  referentConfidenceN: 0,
  xFitSum: 0,
  xFitN: 0,
  copiesRecent: 0,
  copiesAnswered: 0,
  trendMatched: 0,
  trendAnswered: 0,
  alerts: 0,
  alertsDescribed: 0,
  alertsGraded: 0,
  alertsWon2x: 0,
  alertsWon4x: 0,
  alertsWon10x: 0,
  alertsTenXGraded: 0,
  alertsReturnN: 0,
  alertsReturnSum: 0,
});

/**
 * Where a run starts summing: the trailing window behind the last hour written, or, with nothing
 * written yet, the oldest row still in any source table.
 */
async function rollupStart(now: Date): Promise<{ from: Date; backfill: boolean }> {
  const trailing = floorHour(now.getTime() - RECOMPUTE_HOURS * HOUR_MS);
  const latest = await prisma.lighthouseHour.aggregate({ _max: { hour: true } });
  if (latest._max.hour) {
    const resume = floorHour(latest._max.hour.getTime() - RECOMPUTE_HOURS * HOUR_MS);
    return { from: resume < trailing ? resume : trailing, backfill: false };
  }
  const [outcome, narrative, alert] = await Promise.all([
    prisma.candidateOutcome.aggregate({ _min: { anchorAt: true }, where: { sampleKind: "event" } }),
    prisma.tokenNarrative.aggregate({ _min: { checkedAt: true } }),
    prisma.curatedAlert.aggregate({ _min: { createdAt: true } }),
  ]);
  const oldest = [outcome._min.anchorAt, narrative._min.checkedAt, alert._min.createdAt]
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((a, b) => (a === null || b < a ? b : a), null);
  if (!oldest) return { from: trailing, backfill: false };
  return { from: floorHour(Math.min(oldest.getTime(), trailing.getTime())), backfill: true };
}

interface ScreenedHourRow {
  hour: Date;
  calls: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  ret_n: bigint;
  ret_sum: number | null;
}

interface ReadsHourRow {
  hour: Date;
  total: bigint;
  described: bigint;
  deep: bigint;
  failed: bigint;
  rc_sum: number | null;
  rc_n: bigint;
  xfit_sum: number | null;
  xfit_n: bigint;
  copies_recent: bigint;
  copies_answered: bigint;
  trend_matched: bigint;
  trend_answered: bigint;
}

interface AlertsHourRow {
  hour: Date;
  alerts: bigint;
  described: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  ret_n: bigint;
  ret_sum: number | null;
}

/** The hourly sums over [from, to), as rows keyed by the hour's epoch ms; hours with nothing stay absent. */
async function sumHours(from: Date, to: Date): Promise<Map<number, HourRow>> {
  const [screened, reads, alerts] = await Promise.all([
    // The same counting and the same population as the Live tab's Lighthouse: rows the safety
    // screen would reject today (wallet cuts) stay out, a 2x after the stop is a loss, and the
    // 10x rate's denominator is every row whose 10x verdict is in (a loss settles it at once).
    prisma.$queryRaw<ScreenedHourRow[]>`
      SELECT date_trunc('hour', co."anchorAt") AS hour,
             count(*) AS calls,
             count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
             count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
             count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
             count(*) FILTER (WHERE co."hit10xIn1h") AS won10x,
             count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL
                                AND (co."hit10xIn1h" IS NOT NULL OR NOT (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)))) AS ten_x_graded,
             count(co."simReturnPct") AS ret_n,
             sum(co."simReturnPct")::float8 AS ret_sum
      FROM "CandidateOutcome" co
      WHERE co."sampleKind" = 'event' AND co."anchorAt" >= ${from} AND co."anchorAt" < ${to}
        AND ${walletSafetyCutsSql(Prisma.raw('co."features"'))}
      GROUP BY 1`,
    prisma.$queryRaw<ReadsHourRow[]>`
      SELECT date_trunc('hour', n."checkedAt") AS hour,
             count(*) AS total,
             count(*) FILTER (WHERE n.status <> 'failed') AS described,
             count(*) FILTER (WHERE n.status <> 'failed' AND n.depth = 'full') AS deep,
             count(*) FILTER (WHERE n.status = 'failed') AS failed,
             sum(n."referentConfidence") FILTER (WHERE n.status <> 'failed')::float8 AS rc_sum,
             count(n."referentConfidence") FILTER (WHERE n.status <> 'failed') AS rc_n,
             sum(n."xFit") FILTER (WHERE n.status <> 'failed')::float8 AS xfit_sum,
             count(n."xFit") FILTER (WHERE n.status <> 'failed') AS xfit_n,
             count(*) FILTER (WHERE n.status <> 'failed' AND n."copiesRecent") AS copies_recent,
             count(n."copiesRecent") FILTER (WHERE n.status <> 'failed') AS copies_answered,
             count(*) FILTER (WHERE n.status <> 'failed' AND n."trendMatched") AS trend_matched,
             count(n."trendMatched") FILTER (WHERE n.status <> 'failed') AS trend_answered
      FROM "TokenNarrative" n
      WHERE n."checkedAt" >= ${from} AND n."checkedAt" < ${to}
      GROUP BY 1`,
    prisma.$queryRaw<AlertsHourRow[]>`
      SELECT date_trunc('hour', a."createdAt") AS hour,
             count(*) AS alerts,
             count(*) FILTER (WHERE n.status IS NOT NULL AND n.status <> 'failed') AS described,
             count(*) FILTER (WHERE a."hit2xIn1h" IS NOT NULL) AS graded,
             count(*) FILTER (WHERE a."hit2xIn1h" AND NOT COALESCE(a."disqualified", false)) AS won2x,
             count(*) FILTER (WHERE a."hit4xIn1h") AS won4x,
             count(*) FILTER (WHERE a."hit10xIn1h") AS won10x,
             count(*) FILTER (WHERE a."hit2xIn1h" IS NOT NULL
                                AND (a."hit10xIn1h" IS NOT NULL OR NOT (a."hit2xIn1h" AND NOT COALESCE(a."disqualified", false)))) AS ten_x_graded,
             count(a."simReturnPct") AS ret_n,
             sum(a."simReturnPct")::float8 AS ret_sum
      FROM "CuratedAlert" a
      JOIN "Token" t ON t.id = a."tokenId"
      LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
      WHERE a."createdAt" >= ${from} AND a."createdAt" < ${to}
      GROUP BY 1`,
  ]);
  const hours = new Map<number, HourRow>();
  const at = (hour: Date) => {
    const key = hour.getTime();
    let row = hours.get(key);
    if (!row) {
      row = emptyHour();
      hours.set(key, row);
    }
    return row;
  };
  for (const r of screened) {
    const h = at(r.hour);
    h.screenedCalls = n(r.calls);
    h.screenedGraded = n(r.graded);
    h.screenedWon2x = n(r.won2x);
    h.screenedWon4x = n(r.won4x);
    h.screenedWon10x = n(r.won10x);
    h.screenedTenXGraded = n(r.ten_x_graded);
    h.screenedReturnN = n(r.ret_n);
    h.screenedReturnSum = r.ret_sum ?? 0;
  }
  for (const r of reads) {
    const h = at(r.hour);
    h.readsTotal = n(r.total);
    h.readsDescribed = n(r.described);
    h.readsDeep = n(r.deep);
    h.readsFailed = n(r.failed);
    h.referentConfidenceSum = r.rc_sum ?? 0;
    h.referentConfidenceN = n(r.rc_n);
    h.xFitSum = r.xfit_sum ?? 0;
    h.xFitN = n(r.xfit_n);
    h.copiesRecent = n(r.copies_recent);
    h.copiesAnswered = n(r.copies_answered);
    h.trendMatched = n(r.trend_matched);
    h.trendAnswered = n(r.trend_answered);
  }
  for (const r of alerts) {
    const h = at(r.hour);
    h.alerts = n(r.alerts);
    h.alertsDescribed = n(r.described);
    h.alertsGraded = n(r.graded);
    h.alertsWon2x = n(r.won2x);
    h.alertsWon4x = n(r.won4x);
    h.alertsWon10x = n(r.won10x);
    h.alertsTenXGraded = n(r.ten_x_graded);
    h.alertsReturnN = n(r.ret_n);
    h.alertsReturnSum = r.ret_sum ?? 0;
  }
  return hours;
}

/** Writes every hour in [from, to): the summed row, or zeros, so a quiet hour reads as quiet, not missing. */
async function writeHours(from: Date, to: Date): Promise<number> {
  const sums = await sumHours(from, to);
  const computedAt = new Date();
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
    const row = sums.get(t) ?? emptyHour();
    writes.push(
      prisma.lighthouseHour.upsert({
        where: { hour: new Date(t) },
        create: { hour: new Date(t), ...row, computedAt },
        update: { ...row, computedAt },
      }),
    );
  }
  if (writes.length) await prisma.$transaction(writes);
  return writes.length;
}

// ---------- Daily label breakdowns ----------

interface LabelCount {
  label: string | null;
  count: bigint;
}

interface AlertRow {
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  status: string | null;
  categories: unknown;
  x_verdict: string | null;
  copies_recent: boolean | null;
  trend_matched: boolean | null;
  referent_kind: string | null;
  referent_support: string[] | null;
  flags: string[] | null;
  pair_kind: string | null;
}

interface LabelTally {
  count: number;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  /** Calls whose 10x verdict is in - the 10x rate's denominator (a loss at 2x settles it). */
  tenXGraded: number;
}

/** The top-level part of the category TokenSage is surest of - adminInsights.topCategory's rule. */
function surestCategory(categories: unknown): string | null {
  if (!Array.isArray(categories)) return null;
  let best: { label: string; confidence: number } | null = null;
  for (const c of categories) {
    if (typeof c !== "object" || c === null) continue;
    const { label, confidence } = c as { label?: unknown; confidence?: unknown };
    if (typeof label !== "string" || typeof confidence !== "number") continue;
    if (!best || confidence > best.confidence) best = { label, confidence };
  }
  return best ? best.label.split("/")[0]!.trim() || best.label : null;
}

/** Every label a coin carries that has a sub-part ("animal/dog"), any confidence. */
function subLabels(categories: unknown): string[] {
  if (!Array.isArray(categories)) return [];
  const out = new Set<string>();
  for (const c of categories) {
    if (typeof c !== "object" || c === null) continue;
    const { label } = c as { label?: unknown };
    if (typeof label === "string" && label.includes("/")) out.add(label);
  }
  return [...out];
}

const COPY_LABEL = (v: boolean) => (v ? "copies a recent coin" : "original");
const NEWS_LABEL = (v: boolean) => (v ? "in the news" : "not in the news");

async function inTurn<T extends readonly (() => Promise<unknown>)[]>(
  queries: [...T],
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const run of queries) out.push(await run());
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/** How many coins TokenSage read under each label of each dimension on the day. */
async function readCounts(from: Date, to: Date): Promise<Record<LabelDimension, LabelCount[]>> {
  const described = (strings: TemplateStringsArray, ...values: unknown[]) =>
    prisma.$queryRaw<LabelCount[]>(strings, ...values);
  // One query at a time: the trainer's pool is small (DATABASE_CONNECTION_LIMIT=6 in render.yaml)
  // and this runs alongside training and the nightly sweeps; nine at once would queue on the pool
  // and could time the whole run out. Each is cheap on its own.
  const [category, subcategory, flag, referentKind, referentSupport, xVerdict, pairKind, copy, news] =
    await inTurn([
      // Each coin once, under the top-level part of the category it is surest of (the tide's rule).
      () => described`
        SELECT split_part(top.label, '/', 1) AS label, count(*) AS count
        FROM "TokenNarrative" n
        LEFT JOIN LATERAL (
          SELECT c->>'label' AS label
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
          WHERE jsonb_typeof(c->'label') = 'string'
          ORDER BY CASE WHEN jsonb_typeof(c->'confidence') = 'number' THEN (c->>'confidence')::float8 END DESC NULLS LAST
          LIMIT 1
        ) top ON true
        WHERE n."checkedAt" >= ${from} AND n."checkedAt" < ${to} AND n.status <> 'failed'
        GROUP BY 1`,
      () => described`
        SELECT c->>'label' AS label, count(DISTINCT n."mintAddress") AS count
        FROM "TokenNarrative" n,
             jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
        WHERE n."checkedAt" >= ${from} AND n."checkedAt" < ${to} AND n.status <> 'failed'
          AND jsonb_typeof(c->'label') = 'string' AND position('/' IN c->>'label') > 0
        GROUP BY 1`,
      () => described`
        SELECT f AS label, count(*) AS count FROM "TokenNarrative", unnest(flags) f
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' GROUP BY 1`,
      // A kind-only referent (rules 0.17.0: "frog", not a named frog) counts under its own label.
      () => described`
        SELECT CASE WHEN "referentGeneric" THEN "referentKind" || ' (kind only)' ELSE "referentKind" END AS label,
               count(*) AS count
        FROM "TokenNarrative"
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' AND "referentKind" IS NOT NULL
        GROUP BY 1`,
      () => described`
        SELECT s AS label, count(*) AS count FROM "TokenNarrative", unnest("referentSupport") s
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' GROUP BY 1`,
      () => described`
        SELECT "xVerdict" AS label, count(*) AS count FROM "TokenNarrative"
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' AND depth = 'full' AND "xVerdict" IS NOT NULL
        GROUP BY 1`,
      () => described`
        SELECT "pairKind" AS label, count(*) AS count FROM "TokenNarrative"
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' AND "pairKind" IS NOT NULL
        GROUP BY 1`,
      () => described`
        SELECT CASE WHEN "copiesRecent" THEN 'copies a recent coin' ELSE 'original' END AS label, count(*) AS count
        FROM "TokenNarrative"
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' AND "copiesRecent" IS NOT NULL
        GROUP BY 1`,
      () => described`
        SELECT CASE WHEN "trendMatched" THEN 'in the news' ELSE 'not in the news' END AS label, count(*) AS count
        FROM "TokenNarrative"
        WHERE "checkedAt" >= ${from} AND "checkedAt" < ${to} AND status <> 'failed' AND "trendMatched" IS NOT NULL
        GROUP BY 1`,
    ]);
  return { category, subcategory, flag, referentKind, referentSupport, xVerdict, pairKind, copy, news };
}

/** The models' calls made on the day with what TokenSage says about their coin now - no mint. */
function alertRows(from: Date, to: Date) {
  return prisma.$queryRaw<AlertRow[]>`
    SELECT (a."hit2xIn1h" AND NOT COALESCE(a."disqualified", false)) AS hit2x, a."hit4xIn1h" AS hit4x, a."hit10xIn1h" AS hit10x,
           n.status, n.categories, n."xVerdict" AS x_verdict, n."copiesRecent" AS copies_recent,
           n."trendMatched" AS trend_matched,
           CASE WHEN n."referentGeneric" THEN n."referentKind" || ' (kind only)' ELSE n."referentKind" END AS referent_kind,
           n."referentSupport" AS referent_support, n.flags, n."pairKind" AS pair_kind
    FROM "CuratedAlert" a
    JOIN "Token" t ON t.id = a."tokenId"
    LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
    WHERE a."createdAt" >= ${from} AND a."createdAt" < ${to}
    ORDER BY a."createdAt" DESC
    LIMIT 50000`;
}

/** One UTC day's rows for LighthouseDayLabel. */
async function labelRowsForDay(day: Date): Promise<Prisma.LighthouseDayLabelCreateManyInput[]> {
  const to = new Date(day.getTime() + DAY_MS);
  const [reads, alerts] = await Promise.all([readCounts(day, to), alertRows(day, to)]);
  const tallies = new Map<string, LabelTally>();
  const at = (dimension: LabelDimension, label: string) => {
    const key = `${dimension}\n${label}`;
    let t = tallies.get(key);
    if (!t) {
      t = { count: 0, alerts: 0, graded: 0, won2x: 0, won4x: 0, won10x: 0, tenXGraded: 0 };
      tallies.set(key, t);
    }
    return t;
  };
  for (const dimension of LABEL_DIMENSIONS) {
    for (const r of reads[dimension]) {
      // The tide's "uncategorized": a described coin with no category yet.
      const label = r.label || (dimension === "category" ? "uncategorized" : null);
      if (label !== null) at(dimension, label).count += n(r.count);
    }
  }
  const tallyAlert = (dimension: LabelDimension, label: string, row: AlertRow) => {
    const t = at(dimension, label);
    t.alerts += 1;
    if (row.hit2x !== null) {
      t.graded += 1;
      if (row.hit2x) t.won2x += 1;
      if (row.hit4x) t.won4x += 1;
      if (row.hit10x) t.won10x += 1;
      // The 10x verdict is in once it lands, or at once for a call that did not cleanly 2x.
      if (row.hit10x !== null || !row.hit2x) t.tenXGraded += 1;
    }
  };
  for (const row of alerts) {
    if (row.status === null || row.status === "failed") continue;
    tallyAlert("category", surestCategory(row.categories) ?? "uncategorized", row);
    for (const label of subLabels(row.categories)) tallyAlert("subcategory", label, row);
    for (const label of new Set(row.flags ?? [])) tallyAlert("flag", label, row);
    if (row.referent_kind) tallyAlert("referentKind", row.referent_kind, row);
    for (const label of new Set(row.referent_support ?? [])) tallyAlert("referentSupport", label, row);
    if (row.x_verdict) tallyAlert("xVerdict", row.x_verdict, row);
    if (row.pair_kind) tallyAlert("pairKind", row.pair_kind, row);
    if (row.copies_recent !== null) tallyAlert("copy", COPY_LABEL(row.copies_recent), row);
    if (row.trend_matched !== null) tallyAlert("news", NEWS_LABEL(row.trend_matched), row);
  }
  return [...tallies.entries()].map(([key, t]) => {
    const [dimension, label] = key.split("\n") as [string, string];
    return { day, dimension, label, ...t };
  });
}

/**
 * Replaces the day's label rows with a fresh sum: labels that vanished go with them. Under a
 * per-day advisory lock: a deploy runs the old trainer and the new one side by side, both
 * summing on boot, and without it the second's createMany lands on the first's rows (the hour
 * rows are upserts and need none). Transaction-scoped, so it releases on commit or rollback.
 */
async function writeDay(day: Date): Promise<number> {
  const rows = await labelRowsForDay(day);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"lighthouse-day:" + day.toISOString()}))`;
    await tx.lighthouseDayLabel.deleteMany({ where: { day } });
    await tx.lighthouseDayLabel.createMany({ data: rows });
  });
  return rows.length;
}

export async function runLighthouseRollupJob(opts: LighthouseRollupOptions = {}): Promise<JobRunMeta> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  // Through the current hour: its row is partial and is re-summed on every run until it is past.
  const to = new Date(floorHour(now.getTime()).getTime() + HOUR_MS);
  const start = opts.from
    ? { from: floorHour(opts.from.getTime()), backfill: false }
    : await rollupStart(now);
  const from = start.from;
  if (start.backfill) {
    logger.info("no history yet: backfilling from the oldest rows still present", {
      from: from.toISOString(),
    });
  }

  let hoursWritten = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    hoursWritten += await writeHours(new Date(t), new Date(Math.min(t + DAY_MS, to.getTime())));
  }
  let daysWritten = 0;
  let labelRows = 0;
  for (let d = floorDay(from.getTime()).getTime(); d < to.getTime(); d += DAY_MS) {
    labelRows += await writeDay(new Date(d));
    daysWritten += 1;
  }
  const meta = {
    from: from.toISOString(),
    to: to.toISOString(),
    backfill: start.backfill,
    hoursWritten,
    daysWritten,
    labelRows,
  };
  logger.info("lighthouse history summed", { ...meta, durationMs: Date.now() - startedAt });
  return meta;
}
