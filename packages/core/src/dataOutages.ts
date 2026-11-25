import { readSharedCreditsOut } from "./apiUsage.js";
import { prisma } from "./db.js";
import { createLogger } from "./logger.js";

const logger = createLogger("data-outages");

/**
 * Helius data gaps (2026-11-25). Helius's credits ran out at 2026-11-22 20:24 UTC and stayed out
 * for over a day. The scanner kept running on its other sources, so the program carried on with
 * no wallet, holder, sniper, linked or tape figures, the screen failing closed and the curve tape
 * (the fine label ticks) silent. Nothing remembered that stretch once it was over: the stand-down
 * (apiUsage.ts) holds only the latest one, and only while it lasts. So the rows banked through it
 * trained with their Helius inputs missing, the live scales read a day of almost no decision
 * moments as the market's flow, and a probation that waited through it was judged on a handful.
 *
 * This is the record of those stretches (the DataOutage table) and the one test everything that
 * learns or grades from stored rows asks of it (OutageSet):
 *  - "credits-out": the shared stand-down, as apiUsage.ts publishes it (open while it lasts);
 *  - "no-billed-calls": a run of 5-minute ApiUsage buckets in which the scanner was billed no
 *    Helius credit at all. That covers the stand-down too, and a refused key or a scanner that was
 *    down, and reaches back over the 8 days ApiUsage keeps, which is how the 11-22 outage is found.
 * pipeline-watch writes both (syncDataOutages); the trainer, the live scales, the score weights,
 * probation and the exit lab read them (loadDataOutages).
 */

export const DATA_OUTAGE_SOURCE = "helius";
export type DataOutageCause = "credits-out" | "no-billed-calls";

/**
 * The shortest run of buckets with no billed Helius credit that counts as an outage. The scanner
 * spends about 2,000 credits a 5-minute bucket, so a quiet bucket is the provider or the process,
 * never the market; a deploy's restart (2-5 minutes) stays under it.
 */
export const OUTAGE_MIN_GAP_MS = 20 * 60_000;
/**
 * How long past an outage's end its rows are still not trusted: the caches and the readings that
 * wait for Helius (wallet checks, holder lists, the Linked reading) take a few scans to catch up.
 */
export const OUTAGE_RECOVERY_MS = 15 * 60_000;
/**
 * How far before its anchor a row's inputs reach: the coin's life up to the decision age cap
 * (MAX_EVENT_AGE_MINUTES in curation/curator.ts, 3 hours). A coin that lived through an outage
 * before it was sampled has holes in its tape, holder growth and launch figures.
 */
export const OUTAGE_ROW_LOOKBACK_MAX_MINUTES = 180;
/**
 * How far after its anchor a row's label reaches: the hour its peak, drawdown and runner tiers are
 * read over. Through an outage the curve tape (the fine ticks) is silent and the grade falls back
 * to DexScreener's coarser ticks.
 */
export const OUTAGE_ROW_LABEL_MS = 60 * 60_000;
/** The furthest a window is pushed back to make up for outage time inside it (OutageSet.windowStart). */
export const OUTAGE_WINDOW_MAX_EXTEND_MS = 7 * 86_400_000;

const USAGE_BUCKET_MS = 5 * 60_000;
/** Buckets younger than this may still be flushed (each process flushes every minute, and keeps a failed flush). */
const USAGE_SETTLE_MS = 15 * 60_000;
/**
 * ApiUsage's retention (apiUsage.ts). Every scan reads all of it: a gap is only seen once it has
 * closed, and its start can be days back (the 11-22 outage ran over a day).
 */
const USAGE_LOOKBACK_MS = 8 * 86_400_000;
/** The usage scan is the backfill and the down-scanner reading; the stand-down is read every call. */
const USAGE_SCAN_EVERY_MS = 60 * 60_000;
/** How long a read of the table is reused in one process. */
const CACHE_MS = 60_000;
/** How far back loadDataOutages reads ended outages. */
const READ_DAYS = 30;

export interface OutageSpan {
  startedAt: Date;
  /** Null while it is still going on. */
  endedAt: Date | null;
  causes: DataOutageCause[];
}

interface RawSpan {
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * Pure: the outages a run of billed buckets leaves, each from the end of the last billed bucket to
 * the start of the next. Only gaps of at least `minGapMs` that closed before `settledBefore`; a
 * gap still open at the newest bucket is the stand-down's to report, or the next scan's.
 */
export function usageGaps(
  billedBuckets: readonly Date[],
  settledBefore: Date,
  minGapMs = OUTAGE_MIN_GAP_MS,
): RawSpan[] {
  const ts = billedBuckets.map((b) => b.getTime()).sort((a, b) => a - b);
  const out: RawSpan[] = [];
  for (let i = 1; i < ts.length; i++) {
    const from = ts[i - 1]! + USAGE_BUCKET_MS;
    const until = ts[i]!;
    if (until - from >= minGapMs && until <= settledBefore.getTime()) {
      out.push({ startedAt: new Date(from), endedAt: new Date(until) });
    }
  }
  return out;
}

/** The shared stand-down as apiUsage.ts writes it (readSharedCreditsOut). */
export interface SharedStandDown {
  since: number;
  until: number;
  setAt: number;
  clearedAt: number;
}

/**
 * Pure: the outage the shared stand-down describes, or null without one. It ends where it was
 * cleared, or where the last stand-down lifted (`until`) once that is past; before then it is open.
 */
export function creditsOutSpan(shared: SharedStandDown | null, now: number): RawSpan | null {
  if (!shared || shared.since <= 0 || shared.until <= shared.since) return null;
  const cleared = shared.clearedAt > 0 && shared.clearedAt >= shared.setAt ? shared.clearedAt : null;
  const end = cleared !== null ? Math.max(shared.since, Math.min(cleared, shared.until)) : shared.until;
  return { startedAt: new Date(shared.since), endedAt: end <= now ? new Date(end) : null };
}

/** Pure: overlapping (or touching) outages joined into one, oldest first. */
export function mergeOutageSpans(
  rows: readonly { startedAt: Date; endedAt: Date | null; cause: string }[],
): OutageSpan[] {
  const sorted = [...rows].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const out: OutageSpan[] = [];
  for (const r of sorted) {
    const cause = r.cause as DataOutageCause;
    const last = out[out.length - 1];
    if (last && (last.endedAt === null || r.startedAt.getTime() <= last.endedAt.getTime())) {
      if (last.endedAt !== null && (r.endedAt === null || r.endedAt > last.endedAt)) last.endedAt = r.endedAt;
      if (!last.causes.includes(cause)) last.causes.push(cause);
      continue;
    }
    out.push({ startedAt: r.startedAt, endedAt: r.endedAt, causes: [cause] });
  }
  return out;
}

/**
 * The outages as one test: what a stored row or a time window has to ask before it is trusted.
 * Each outage taints from its start to OUTAGE_RECOVERY_MS past its end (now, for one still open).
 */
export class OutageSet {
  /** [from, until) in ms, oldest first, recovery included. */
  private readonly ranges: [number, number][];

  constructor(
    readonly spans: readonly OutageSpan[],
    readonly now: number = Date.now(),
  ) {
    this.ranges = spans
      .map((s): [number, number] => [
        s.startedAt.getTime(),
        (s.endedAt?.getTime() ?? now) + OUTAGE_RECOVERY_MS,
      ])
      .sort((a, b) => a[0] - b[0]);
  }

  static readonly none = new OutageSet([]);

  get empty(): boolean {
    return this.ranges.length === 0;
  }

  /** Whether `t` falls in an outage (or its recovery). */
  covers(t: Date | number): boolean {
    const at = typeof t === "number" ? t : t.getTime();
    return this.ranges.some(([a, b]) => at >= a && at < b);
  }

  /** Whether [from, until) touches an outage (or its recovery). */
  overlaps(from: Date | number, until: Date | number): boolean {
    const f = typeof from === "number" ? from : from.getTime();
    const u = typeof until === "number" ? until : until.getTime();
    return this.ranges.some(([a, b]) => f < b && u > a);
  }

  /** How much of [from, until) falls in outages (or their recovery), in ms. */
  overlapMs(from: Date | number, until: Date | number): number {
    const f = typeof from === "number" ? from : from.getTime();
    const u = typeof until === "number" ? until : until.getTime();
    let total = 0;
    let reached = f;
    for (const [a, b] of this.ranges) {
      const s = Math.max(a, reached);
      const e = Math.min(b, u);
      if (e > s) {
        total += e - s;
        reached = e;
      }
    }
    return total;
  }

  /**
   * Whether an outage touched a stored row: its inputs (the coin's life before the anchor, up to
   * OUTAGE_ROW_LOOKBACK_MAX_MINUTES; the full lookback when the age is unknown) or its label's
   * hour after it. Such a row neither trains nor grades.
   */
  taintsRow(anchorAt: Date, ageMinutes?: number | null): boolean {
    if (this.ranges.length === 0) return false;
    const at = anchorAt.getTime();
    const age =
      typeof ageMinutes === "number" && Number.isFinite(ageMinutes) && ageMinutes >= 0
        ? Math.min(ageMinutes, OUTAGE_ROW_LOOKBACK_MAX_MINUTES)
        : OUTAGE_ROW_LOOKBACK_MAX_MINUTES;
    return this.overlaps(at - age * 60_000, at + OUTAGE_ROW_LABEL_MS);
  }

  /**
   * Where a window ending at `now` has to start to hold `windowMs` of time outside outages: a
   * "last 24 hours of decision moments" read just after a day-long outage holds a day of moments,
   * not the hour since. Pushed back by OUTAGE_WINDOW_MAX_EXTEND_MS at most.
   */
  windowStart(now: Date | number, windowMs: number): Date {
    const n = typeof now === "number" ? now : now.getTime();
    let start = n - windowMs;
    for (let i = 0; i < 20; i++) {
      const next = Math.max(
        n - windowMs - this.overlapMs(start, n),
        n - windowMs - OUTAGE_WINDOW_MAX_EXTEND_MS,
      );
      if (next === start) break;
      start = next;
    }
    return new Date(start);
  }
}

let cached: { at: number; set: OutageSet } | null = null;

/** Test hook: forget the cached read and the usage scan's clock. */
export function resetDataOutageCache(): void {
  cached = null;
  lastUsageScanAt = 0;
}

/**
 * The outages of the last READ_DAYS (and any still open), read at most once a CACHE_MS per process.
 * A failed read is an empty set, logged: nothing stops for want of it.
 */
export async function loadDataOutages(now = Date.now()): Promise<OutageSet> {
  if (cached && now - cached.at < CACHE_MS && now >= cached.at) return cached.set;
  try {
    const rows = await prisma.dataOutage.findMany({
      where: {
        source: DATA_OUTAGE_SOURCE,
        OR: [{ endedAt: null }, { endedAt: { gte: new Date(now - READ_DAYS * 86_400_000) } }],
      },
      select: { startedAt: true, endedAt: true, cause: true },
    });
    const set = new OutageSet(mergeOutageSpans(rows), now);
    cached = { at: now, set };
    return set;
  } catch (err) {
    logger.warn("data outages not read; reading none", { error: String(err) });
    return OutageSet.none;
  }
}

/** An outage as the health page, Admin > Worker and the hit-rate report list it. */
export interface OutageView {
  startedAt: string;
  /** Null while it is still going on. */
  endedAt: string | null;
  /** How long it lasted, or has lasted so far. */
  minutes: number;
  causes: DataOutageCause[];
}

/** Days of outages /health/worker and Admin > Worker list. */
export const DATA_OUTAGE_LIST_DAYS = 14;

/** Pure: the views of `spans`, newest first. */
export function outageViews(spans: readonly OutageSpan[], now = Date.now()): OutageView[] {
  return [...spans]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .map((s) => ({
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      minutes: Math.round(((s.endedAt?.getTime() ?? now) - s.startedAt.getTime()) / 60_000),
      causes: [...s.causes].sort(),
    }));
}

/**
 * The outages that touch [since, until), merged, newest first. A failed read (the table missing on
 * an API ahead of its migration) is an empty list, logged: a report never fails for want of it.
 */
export async function dataOutagesBetween(since: Date, until: Date, now = Date.now()): Promise<OutageView[]> {
  try {
    const rows = await prisma.dataOutage.findMany({
      where: {
        source: DATA_OUTAGE_SOURCE,
        startedAt: { lt: until },
        OR: [{ endedAt: null }, { endedAt: { gt: since } }],
      },
      select: { startedAt: true, endedAt: true, cause: true },
    });
    return outageViews(mergeOutageSpans(rows), now);
  } catch (err) {
    logger.warn("data outages not read for a report", { error: String(err) });
    return [];
  }
}

async function upsertOutage(cause: DataOutageCause, span: RawSpan): Promise<void> {
  await prisma.dataOutage.upsert({
    where: { source_cause_startedAt: { source: DATA_OUTAGE_SOURCE, cause, startedAt: span.startedAt } },
    create: { source: DATA_OUTAGE_SOURCE, cause, startedAt: span.startedAt, endedAt: span.endedAt },
    update: { endedAt: span.endedAt },
  });
}

let lastUsageScanAt = 0;

/**
 * Brings the record up to date (pipeline-watch, every minute): the shared stand-down every call,
 * the scanner's billed buckets every USAGE_SCAN_EVERY_MS (all 8 days ApiUsage keeps, so a deploy
 * finds the outages ApiUsage still shows). `process` is the scanner's ApiUsage process name
 * (`worker-scanner` in production). A stand-down row left open by an earlier `since` (a process
 * that latched on its own before it read the shared one) is closed where the newer one starts, so
 * no row stays open for ever.
 */
export async function syncDataOutages(
  process: string,
  now = Date.now(),
  deps: { readShared?: () => Promise<SharedStandDown | null> } = {},
): Promise<{ open: boolean; gaps: number }> {
  const span = creditsOutSpan(await (deps.readShared ?? readSharedCreditsOut)(), now);
  if (span) await upsertOutage("credits-out", span);
  const closeAt = span ? span.startedAt : new Date(now);
  await prisma.dataOutage.updateMany({
    where: {
      source: DATA_OUTAGE_SOURCE,
      cause: "credits-out",
      endedAt: null,
      startedAt: { lt: closeAt },
    },
    data: { endedAt: closeAt },
  });
  let gaps = 0;
  if (now - lastUsageScanAt >= USAGE_SCAN_EVERY_MS || now < lastUsageScanAt) {
    const since = new Date(now - USAGE_LOOKBACK_MS);
    const settled = new Date(now - USAGE_SETTLE_MS);
    const billed = await prisma.$queryRaw<{ bucket: Date }[]>`
      SELECT "bucket" FROM "ApiUsage"
      WHERE "provider" = 'helius' AND "process" = ${process} AND "bucket" >= ${since} AND "bucket" < ${settled}
      GROUP BY "bucket" HAVING SUM("credits") > 0
      ORDER BY "bucket"`;
    for (const gap of usageGaps(
      billed.map((b) => b.bucket),
      settled,
    )) {
      await upsertOutage("no-billed-calls", gap);
      gaps += 1;
    }
    lastUsageScanAt = now;
  }
  cached = null;
  return { open: span !== null && span.endedAt === null, gaps };
}
