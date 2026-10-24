import { prisma } from "@trenchscanner/core";
import { TOP_UP_WAIT_MS, topUpDueIn } from "./candleTopUp.js";

/**
 * What a chart waiting on missing candles is told (user ask 2026-10-24: a label over the missing
 * stretch that it is being backfilled, with a progress bar and an ETA). Only what will still fill
 * a hole counts: the coin's GeckoTerminal backfill in the worker's queue (candleBackfill.ts), paged
 * from now back to its launch, or the chart's own top-up of its newest minutes (candleTopUp.ts).
 * Once neither is left, a hole is one no source had, and the chart says so instead.
 */
export interface BackfillStatus {
  /** About how long until the history lands (ms); null when not known. */
  etaMs: number | null;
  /** How much of the coin's history the backfill has paged, 0 to 1; null when not known. */
  progress: number | null;
}

const MINUTE_MS = 60_000;
/** Minutes a GeckoTerminal page holds. */
const PAGE_MINUTES = 1_000;
/** A coin's status is read at most this often per process. */
const FRESH_MS = 10_000;
/** The jobs ahead counted at most (the ETA past them is "a while" either way). */
const AHEAD_MAX = 500;
const MAX_COINS = 2_000;

export interface BackfillJobRow {
  reason: string;
  requestedAt: Date;
  nextAt: Date;
  cursor: Date | null;
  pages: number;
  doneAt: Date | null;
}

/**
 * Exported for tests. The status from the coin's backfill job, the pages the jobs ahead of it in
 * the queue still need, and the worker's pace. Null when its job is done or there is none.
 */
export function jobStatus(
  job: BackfillJobRow | null,
  launchedAt: Date | null,
  pagesAhead: number,
  stepMs: number,
  maxPages: number,
  now: number,
): BackfillStatus | null {
  if (!job || job.doneAt) return null;
  const launch = launchedAt?.getTime() ?? null;
  const from = job.cursor?.getTime() ?? now;
  const own =
    launch === null
      ? 1
      : Math.max(1, Math.min(maxPages - job.pages, Math.ceil((from - launch) / (PAGE_MINUTES * MINUTE_MS))));
  const wait = Math.max(0, job.nextAt.getTime() - now);
  const progress =
    launch === null || now <= launch ? null : Math.min(1, Math.max(0, (now - from) / (now - launch)));
  return { etaMs: wait + (pagesAhead + own) * stepMs, progress };
}

const held = new Map<string, { at: number; status: BackfillStatus | null }>();

/**
 * The coin's status, for an answer whose newest page has holes; null when nothing is left that
 * would fill them. `topUp`: the page has a hole the chart's top-up reaches. `stepMs`: the worker's time a page (60 s over its pages a minute).
 */
export async function backfillStatus(
  mint: string,
  launchedAt: Date | null,
  opts: { stepMs: number; maxPages: number; topUp: boolean; now?: number },
): Promise<BackfillStatus | null> {
  const now = opts.now ?? Date.now();
  // The top-up reaches only the newest page's holes (candleTopUp.ts wantsTopUp).
  const top = opts.topUp ? topUpDueIn(mint) : null;
  const cached = held.get(mint);
  let job: BackfillStatus | null;
  if (cached && now - cached.at < FRESH_MS) job = cached.status;
  else {
    job = await readJob(mint, launchedAt, opts.stepMs, opts.maxPages, now).catch(() => null);
    if (held.size >= MAX_COINS) held.clear();
    held.set(mint, { at: now, status: job });
  }
  if (job)
    return top === null ? job : { ...job, etaMs: Math.min(job.etaMs ?? Infinity, top + TOP_UP_WAIT_MS) };
  return top === null ? null : { etaMs: top + TOP_UP_WAIT_MS, progress: null };
}

async function readJob(
  mint: string,
  launchedAt: Date | null,
  stepMs: number,
  maxPages: number,
  now: number,
): Promise<BackfillStatus | null> {
  const job = await prisma.candleBackfill.findUnique({
    where: { mint },
    select: { reason: true, requestedAt: true, nextAt: true, cursor: true, pages: true, doneAt: true },
  });
  if (!job || job.doneAt) return null;
  // The jobs the worker takes first (candleBackfill.ts claimJob: calls, then the oldest asked), and
  // the pages each still needs back to its coin's launch.
  const call = job.reason === "call";
  const pageMs = PAGE_MINUTES * MINUTE_MS;
  const rows = await prisma.$queryRaw<{ pages: number | null }[]>`
    SELECT COALESCE(SUM(GREATEST(1, LEAST(${maxPages} - b."pages",
      CEIL(EXTRACT(EPOCH FROM (COALESCE(b."cursor", ${new Date(now)}) - COALESCE(t."launchedAt", COALESCE(b."cursor", ${new Date(now)})))) * 1000 / ${pageMs})))), 0)::int AS "pages"
    FROM (
      SELECT * FROM "CandleBackfill" WHERE "doneAt" IS NULL AND "mint" <> ${mint}
        AND ((("reason" = 'call') AND NOT ${call}) OR (("reason" = 'call') = ${call} AND "requestedAt" < ${job.requestedAt}))
      ORDER BY ("reason" = 'call') DESC, "requestedAt" LIMIT ${AHEAD_MAX}
    ) b LEFT JOIN "Token" t ON t."mintAddress" = b."mint"`;
  return jobStatus(job, launchedAt, rows[0]?.pages ?? 0, stepMs, maxPages, now);
}

/** Tests: a clean slate. */
export function resetBackfillStatus(): void {
  held.clear();
}
