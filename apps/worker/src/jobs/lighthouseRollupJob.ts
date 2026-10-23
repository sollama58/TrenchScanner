import {
  prisma,
  createLogger,
  REPORTED_LABEL_RULE,
  walletSafetyCutsSql,
  firstCallOnRowSql,
  notRetiredModelSql,
  Prisma,
} from "@trenchscanner/core";
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
 * A change to how the screened counts are summed bumps LIGHTHOUSE_ROLLUP_VERSION, and the hours
 * written before it are then re-summed once, a batch a run (catchUpScreened).
 *
 * Aggregates only: no mint, name, referent or summary leaves the source tables.
 */

/**
 * The summing rules the screened counts follow (LighthouseHour.rollupVersion). 1 (2026-10-17):
 * rows under an older label rule stay out (labelRule >= REPORTED_LABEL_RULE).
 */
export const LIGHTHOUSE_ROLLUP_VERSION = 1;

/** Older hours re-summed per run while some carry an older rollupVersion: a week of decision moments. */
export const CATCH_UP_HOURS_PER_RUN = 7 * 24;

/** CANDIDATE_OUTCOME_RETENTION_DAYS's default: decision moments younger than this are all still kept. */
const DEFAULT_OUTCOME_RETENTION_DAYS = 90;

/** Hours re-summed on every run, so late grades and re-reads land. */
export const RECOMPUTE_HOURS = 72;

/**
 * Hours whose safety-screen counts (screenAccepted / screenRejected) are re-summed on every run,
 * so a token that clears the screen a while after it was first scanned moves over. Shorter than
 * RECOMPUTE_HOURS on purpose: the counts read TokenSnapshot, and the cleanup deletes an untracked
 * token's snapshots after SNAPSHOT_UNTRACKED_RETENTION_HOURS (48), so an hour summed again past
 * that would lose its rejected tokens. Older hours keep the counts they were last summed with.
 */
export const SCREEN_RECOMPUTE_HOURS = 24;

/**
 * How far back the screen counts are summed when no hour carries any yet (the first run after
 * they were added): as far as every scanned token still has all its snapshots, with a margin.
 */
export const SCREEN_BACKFILL_HOURS = 46;

/**
 * Hours whose scan volume (scanVolumeUsd / scanVolumeTokens) is re-summed on every run: the
 * current, partial hour and the two before it, so an hour still filling at one run is summed whole
 * at the next (the rollup runs hourly). Older hours keep what they were summed with: the volume
 * reads TokenSnapshot, and untracked tokens' snapshots are deleted after
 * SNAPSHOT_UNTRACKED_RETENTION_HOURS.
 */
export const VOLUME_RECOMPUTE_HOURS = 3;

/** How far back the scan volume is summed when no hour carries any yet, as for the screen counts. */
export const VOLUME_BACKFILL_HOURS = SCREEN_BACKFILL_HOURS;

/**
 * Tokens counted toward an hour's volume: first scanned at most this long before it. The scan's
 * watchlist follows a token for WATCHLIST_TTL_HOURS (24) at most, so an older one has no snapshot
 * to read anyway; bounding it keeps the population an index range on Token.firstSeenAt.
 */
export const VOLUME_LOOKBACK_HOURS = 24;

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
  /**
   * CANDIDATE_OUTCOME_RETENTION_DAYS: an older hour's decision moments are partly swept (only
   * the doublers and the called rows stay), so the catch-up never re-sums it.
   */
  outcomeRetentionDays?: number;
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
  screenedReturnOpen: 0,
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
  alertsReturnOpen: 0,
  screenAccepted: 0,
  screenRejected: 0,
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

/**
 * Where a run starts re-summing the screen counts: the trailing SCREEN_RECOMPUTE_HOURS, or
 * SCREEN_BACKFILL_HOURS while no hour carries any yet.
 */
async function screenStart(now: Date): Promise<Date> {
  const any = await prisma.lighthouseHour.findFirst({
    where: { OR: [{ screenAccepted: { gt: 0 } }, { screenRejected: { gt: 0 } }] },
    select: { hour: true },
  });
  const hours = any ? SCREEN_RECOMPUTE_HOURS : SCREEN_BACKFILL_HOURS;
  return floorHour(now.getTime() - hours * HOUR_MS);
}

/**
 * Where a run starts re-summing the scan volume: the trailing VOLUME_RECOMPUTE_HOURS, or
 * VOLUME_BACKFILL_HOURS while no hour carries any yet.
 */
async function volumeStart(now: Date): Promise<Date> {
  const any = await prisma.lighthouseHour.findFirst({
    where: { scanVolumeUsd: { not: null } },
    select: { hour: true },
  });
  const hours = any ? VOLUME_RECOMPUTE_HOURS : VOLUME_BACKFILL_HOURS;
  return floorHour(now.getTime() - hours * HOUR_MS);
}

interface VolumeHourRow {
  hour: Date;
  volume: number | null;
  tokens: bigint;
}

/**
 * The USD volume the scan's tokens traded per hour of [from, to). For each token first scanned up
 * to VOLUME_LOOKBACK_HOURS before an hour and seen live (Token.lastLiveAt) in it or after, its
 * last snapshot in the hour: DexScreener's trailing-hour volume (volume1hUsd) at that moment,
 * scaled to the part of that trailing hour inside this one (spread evenly, and never before the
 * token existed). The last reading of an hour covers nearly all of it, and a token whose last
 * reading came early in the hour (it left the watchlist) adds only that early part, so no trade
 * is counted in two hours. One index probe per token and hour on TokenSnapshot(tokenId, takenAt),
 * over tokens found by Token(firstSeenAt): never a walk of the snapshot table by time.
 *
 * JIT is off for it: the planner can't size generate_series per token (it guesses 1000 rows), so
 * it priced this in the millions and spent over a second compiling a query that runs in well
 * under 100 ms (EXPLAIN ANALYZE, 2026-10-23: 3 hours over a day of 1000 tokens an hour, 84 ms
 * with JIT off against 1.3 s of JIT compilation with it on).
 */
async function volumeHours(from: Date, to: Date): Promise<VolumeHourRow[]> {
  const [, rows] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL jit = off`,
    prisma.$queryRaw<VolumeHourRow[]>`
      SELECT h.hour AS hour,
             sum(v.volume)::float8 AS volume,
             count(v.volume) AS tokens
      FROM "Token" t
      CROSS JOIN LATERAL generate_series(
        greatest(${from}::timestamp, date_trunc('hour', t."firstSeenAt")),
        least(${to}::timestamp - interval '1 hour', date_trunc('hour', t."lastLiveAt")),
        interval '1 hour'
      ) AS h(hour)
      CROSS JOIN LATERAL (
        SELECT s."volume1hUsd" * CASE
                 WHEN s."takenAt" <= b.born THEN 1
                 ELSE LEAST(1, GREATEST(0,
                   extract(epoch FROM s."takenAt" - GREATEST(h.hour, b.born))
                   / extract(epoch FROM s."takenAt" - b.born)))
               END AS volume
        FROM "TokenSnapshot" s
        CROSS JOIN LATERAL (
          SELECT GREATEST(s."takenAt" - interval '1 hour',
                          LEAST(COALESCE(t."launchedAt", t."firstSeenAt"), t."firstSeenAt")) AS born
        ) b
        WHERE s."tokenId" = t.id AND s."takenAt" >= h.hour AND s."takenAt" < h.hour + interval '1 hour'
          AND s."volume1hUsd" IS NOT NULL
        ORDER BY s."takenAt" DESC
        LIMIT 1
      ) v
      WHERE t."firstSeenAt" >= ${from}::timestamp - make_interval(hours => ${VOLUME_LOOKBACK_HOURS}::int)
        AND t."firstSeenAt" < ${to}::timestamp
        AND t."lastLiveAt" >= ${from}::timestamp
      GROUP BY 1`,
  ]);
  return rows;
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
  /** Of ret_n, the calls still open, priced at their latest reading. */
  ret_open: bigint;
}

interface ScreenHourRow {
  hour: Date;
  accepted: bigint;
  rejected: bigint;
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
  /** Of ret_n, the calls still open, priced at their latest reading. */
  ret_open: bigint;
}

/**
 * What the safety screen made of the tokens first scanned in [from, to), by that hour: accepted
 * if any of a token's snapshots passed runRugScreen, rejected if it was scanned and none did. A
 * token is scanned (and gets its Token row and first snapshot, pass or fail) by processCandidate
 * in the scan job; tokens with no snapshot were never screened and count as neither. Two index
 * probes per token on TokenSnapshot(tokenId, takenAt), never a walk of the table by time.
 */
function screenHours(from: Date, to: Date) {
  return prisma.$queryRaw<ScreenHourRow[]>`
    SELECT date_trunc('hour', t."firstSeenAt") AS hour,
           count(*) FILTER (WHERE v.passed) AS accepted,
           count(*) FILTER (WHERE NOT v.passed) AS rejected
    FROM "Token" t
    CROSS JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM "TokenSnapshot" s WHERE s."tokenId" = t.id AND s."rugScreenPassed") AS passed
    ) v
    WHERE t."firstSeenAt" >= ${from} AND t."firstSeenAt" < ${to}
      AND EXISTS (SELECT 1 FROM "TokenSnapshot" s WHERE s."tokenId" = t.id)
    GROUP BY 1`;
}

/**
 * The hourly sums over [from, to), as rows keyed by the hour's epoch ms; hours with nothing stay
 * absent. The screen counts are summed from `screenFrom` only (see SCREEN_RECOMPUTE_HOURS).
 */
/**
 * The screened decision moments of [from, to) by hour - the same counting and the same
 * population as the Live tab's Lighthouse: rows the safety screen would reject today (wallet
 * cuts) and rows under an older label rule stay out, a 2x after the stop is a loss, and the 10x
 * rate's denominator is every row whose 10x verdict is in (a loss settles it at once).
 */
function screenedHours(from: Date, to: Date) {
  return prisma.$queryRaw<ScreenedHourRow[]>`
      SELECT date_trunc('hour', co."anchorAt") AS hour,
             count(*) AS calls,
             count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL) AS graded,
             count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
             count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
             count(*) FILTER (WHERE co."hit10xIn1h") AS won10x,
             count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL
                                AND (co."hit10xIn1h" IS NOT NULL OR NOT (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)))) AS ten_x_graded,
             -- A call still riding its trailing share counts at its latest reading (openReturnPct),
             -- so an hour's average doesn't lean on the losers that settle first. Every run
             -- re-sums the trailing RECOMPUTE_HOURS, which covers the plan's three-hour hold.
             count(COALESCE(co."simReturnPct", co."openReturnPct")) AS ret_n,
             sum(COALESCE(co."simReturnPct", co."openReturnPct"))::float8 AS ret_sum,
             count(co."openReturnPct") FILTER (WHERE co."simReturnPct" IS NULL) AS ret_open
      FROM "CandidateOutcome" co
      WHERE co."sampleKind" = 'event' AND co."anchorAt" >= ${from} AND co."anchorAt" < ${to}
        AND co."labelRule" >= ${REPORTED_LABEL_RULE}
        AND ${walletSafetyCutsSql(Prisma.raw('co."features"'))}
      GROUP BY 1`;
}

/** One hour's screened columns from its screenedHours row (zeros for an hour with none). */
function screenedColumns(r: ScreenedHourRow | undefined) {
  return {
    screenedCalls: n(r?.calls),
    screenedGraded: n(r?.graded),
    screenedWon2x: n(r?.won2x),
    screenedWon4x: n(r?.won4x),
    screenedWon10x: n(r?.won10x),
    screenedTenXGraded: n(r?.ten_x_graded),
    screenedReturnN: n(r?.ret_n),
    screenedReturnSum: r?.ret_sum ?? 0,
    screenedReturnOpen: n(r?.ret_open),
  };
}

async function sumHours(from: Date, to: Date, screenFrom: Date): Promise<Map<number, HourRow>> {
  const screenStart = screenFrom > from ? screenFrom : from;
  const [screened, reads, alerts, screen] = await Promise.all([
    screenedHours(from, to),
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
             count(COALESCE(a."simReturnPct", co."openReturnPct")) AS ret_n,
             sum(COALESCE(a."simReturnPct", co."openReturnPct"))::float8 AS ret_sum,
             count(co."openReturnPct") FILTER (WHERE a."simReturnPct" IS NULL) AS ret_open
      FROM "CuratedAlert" a
      LEFT JOIN "CandidateOutcome" co ON co.id = a."candidateOutcomeId"
      JOIN "Token" t ON t.id = a."tokenId"
      LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
      WHERE a."createdAt" >= ${from} AND a."createdAt" < ${to} AND ${notRetiredModelSql()}
        AND ${firstCallOnRowSql()}
      GROUP BY 1`,
    screenStart < to ? screenHours(screenStart, to) : Promise.resolve([] as ScreenHourRow[]),
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
  for (const r of screened) Object.assign(at(r.hour), screenedColumns(r));
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
    h.alertsReturnOpen = n(r.ret_open);
  }
  for (const r of screen) {
    const h = at(r.hour);
    h.screenAccepted = n(r.accepted);
    h.screenRejected = n(r.rejected);
  }
  return hours;
}

/**
 * Writes every hour in [from, to): the summed row, or zeros, so a quiet hour reads as quiet, not
 * missing. An hour before `screenFrom` keeps the screen counts it already has, and one before
 * `volumeFrom` the scan volume.
 */
async function writeHours(from: Date, to: Date, screenFrom: Date, volumeFrom: Date): Promise<number> {
  const volumeFirst = volumeFrom > from ? volumeFrom : from;
  const [sums, volumes] = await Promise.all([
    sumHours(from, to, screenFrom),
    volumeFirst < to ? volumeHours(volumeFirst, to) : Promise.resolve([] as VolumeHourRow[]),
  ]);
  const volumeBy = new Map(volumes.map((r) => [r.hour.getTime(), r]));
  const computedAt = new Date();
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
    const row = sums.get(t) ?? emptyHour();
    const { screenAccepted: _accepted, screenRejected: _rejected, ...unscreened } = row;
    // An hour summed for volume with nothing traded is a quiet hour (0), not an unsummed one (null).
    const v = volumeBy.get(t);
    const volume =
      t >= volumeFirst.getTime() ? { scanVolumeUsd: v?.volume ?? 0, scanVolumeTokens: n(v?.tokens) } : {};
    writes.push(
      prisma.lighthouseHour.upsert({
        where: { hour: new Date(t) },
        create: {
          hour: new Date(t),
          ...row,
          ...volume,
          rollupVersion: LIGHTHOUSE_ROLLUP_VERSION,
          computedAt,
        },
        update: {
          ...(t >= screenFrom.getTime() ? row : unscreened),
          ...volume,
          rollupVersion: LIGHTHOUSE_ROLLUP_VERSION,
          computedAt,
        },
      }),
    );
  }
  if (writes.length) await prisma.$transaction(writes);
  return writes.length;
}

/**
 * Re-sums only the return columns (screened and alerts) of the hours in [from, to), on hours
 * already written: for history whose returns were re-scored after it was summed
 * (exitPlanRescore.ts). Every other column keeps what it was frozen with.
 */
export async function resumLighthouseReturns(from: Date, to: Date): Promise<number> {
  const sums = await sumHours(from, to, to);
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
    const row = sums.get(t) ?? emptyHour();
    writes.push(
      prisma.lighthouseHour.updateMany({
        where: { hour: new Date(t) },
        data: {
          screenedReturnN: row.screenedReturnN,
          screenedReturnSum: row.screenedReturnSum,
          screenedReturnOpen: row.screenedReturnOpen,
          alertsReturnN: row.alertsReturnN,
          alertsReturnSum: row.alertsReturnSum,
          alertsReturnOpen: row.alertsReturnOpen,
        },
      }),
    );
  }
  if (writes.length) await prisma.$transaction(writes);
  return writes.length;
}

/**
 * Re-sums the screened counts of the oldest CATCH_UP_HOURS_PER_RUN hours still below
 * LIGHTHOUSE_ROLLUP_VERSION, before `before` (where this run's own sums start), and stamps them
 * with it: after a change to the summing rules, the stored history follows them within a few
 * runs, a week of decision moments at a time, so no run stalls on it. Only the screened columns:
 * the reads and calls of an older hour stay frozen as designed (a TokenNarrative row moves to its
 * newest read's hour), and the label days read no decision moments. Only hours whose decision
 * moments are all still kept (CANDIDATE_OUTCOME_RETENTION_DAYS): past that only the doublers and
 * the called rows remain, and a re-sum would read a near-100% hit rate.
 */
async function catchUpScreened(
  now: Date,
  before: Date,
  retentionDays: number,
): Promise<{ from: string; to: string; hours: number } | null> {
  const horizon = new Date(floorHour(now.getTime() - retentionDays * DAY_MS).getTime() + HOUR_MS);
  const oldest = await prisma.lighthouseHour.findFirst({
    where: { rollupVersion: { lt: LIGHTHOUSE_ROLLUP_VERSION }, hour: { gte: horizon, lt: before } },
    orderBy: { hour: "asc" },
    select: { hour: true },
  });
  if (!oldest) return null;
  const from = oldest.hour;
  const to = new Date(Math.min(from.getTime() + CATCH_UP_HOURS_PER_RUN * HOUR_MS, before.getTime()));
  const sums = new Map((await screenedHours(from, to)).map((r) => [r.hour.getTime(), r]));
  const computedAt = new Date();
  const writes: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
    writes.push(
      prisma.lighthouseHour.updateMany({
        where: { hour: new Date(t), rollupVersion: { lt: LIGHTHOUSE_ROLLUP_VERSION } },
        data: { ...screenedColumns(sums.get(t)), rollupVersion: LIGHTHOUSE_ROLLUP_VERSION, computedAt },
      }),
    );
  }
  const updated = (await prisma.$transaction(writes)).reduce((sum, r) => sum + r.count, 0);
  return { from: from.toISOString(), to: to.toISOString(), hours: updated };
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
  main_category: string | null;
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

/**
 * The top-level part of the coin's one category - adminInsights.topCategory's rule: TokenSage's
 * main category (rules 0.20.0+), else the category it is surest of.
 */
function surestCategory(categories: unknown, mainCategory: string | null): string | null {
  const main = mainCategory?.trim();
  if (main) return main.split("/")[0]!.trim() || main;
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
      // Each coin once, under the top-level part of its main category, else the one it is surest of (the tide's rule).
      () => described`
        SELECT split_part(COALESCE(n."mainCategory", top.label), '/', 1) AS label, count(*) AS count
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
           n.status, n.categories, n."mainCategory" AS main_category, n."xVerdict" AS x_verdict, n."copiesRecent" AS copies_recent,
           n."trendMatched" AS trend_matched,
           CASE WHEN n."referentGeneric" THEN n."referentKind" || ' (kind only)' ELSE n."referentKind" END AS referent_kind,
           n."referentSupport" AS referent_support, n.flags, n."pairKind" AS pair_kind
    FROM "CuratedAlert" a
    JOIN "Token" t ON t.id = a."tokenId"
    LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
    WHERE a."createdAt" >= ${from} AND a."createdAt" < ${to} AND ${notRetiredModelSql()}
      AND ${firstCallOnRowSql()}
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
    tallyAlert("category", surestCategory(row.categories, row.main_category) ?? "uncategorized", row);
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

  // Never further back than every scanned token still has all its snapshots, even when asked to
  // re-sum from an older hour: past that the cleanup has taken untracked tokens' snapshots, so a
  // re-sum would drop most rejected tokens and overwrite the counts those hours were frozen with.
  const screenFloor = floorHour(now.getTime() - SCREEN_BACKFILL_HOURS * HOUR_MS);
  const screenFrom = opts.from ? (from > screenFloor ? from : screenFloor) : await screenStart(now);
  // The scan volume reads the same snapshots, under the same floor.
  const volumeFloor = floorHour(now.getTime() - VOLUME_BACKFILL_HOURS * HOUR_MS);
  const volumeFrom = opts.from ? (from > volumeFloor ? from : volumeFloor) : await volumeStart(now);

  // A day at a time: its hours, then at once its labels. Writing every hour first and every
  // label after meant a first-run backfill cut short (a deadline exit, a deploy) left the label
  // days it never reached unwritten for good - the next run resumes from the newest HOUR, and
  // those were all in. Now a run cut anywhere has labelled every day before the one it was on,
  // and that one is inside the resume's trailing hours.
  let hoursWritten = 0;
  let daysWritten = 0;
  let labelRows = 0;
  for (let d = floorDay(from.getTime()).getTime(); d < to.getTime(); d += DAY_MS) {
    const hoursFrom = Math.max(d, from.getTime());
    hoursWritten += await writeHours(
      new Date(hoursFrom),
      new Date(Math.min(d + DAY_MS, to.getTime())),
      screenFrom,
      volumeFrom,
    );
    labelRows += await writeDay(new Date(d));
    daysWritten += 1;
  }
  const catchUp = await catchUpScreened(
    now,
    from,
    opts.outcomeRetentionDays ?? DEFAULT_OUTCOME_RETENTION_DAYS,
  );
  const meta = {
    from: from.toISOString(),
    to: to.toISOString(),
    backfill: start.backfill,
    screenFrom: screenFrom.toISOString(),
    volumeFrom: volumeFrom.toISOString(),
    hoursWritten,
    daysWritten,
    labelRows,
    ...(catchUp ? { catchUp } : {}),
  };
  logger.info("lighthouse history summed", { ...meta, durationMs: Date.now() - startedAt });
  return meta;
}
