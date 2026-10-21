import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, writeLiveMarketData } from "@trenchscanner/core";
import { liveCurves } from "../liveCurve.js";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import type { ViewStampBuffer } from "../viewStamps.js";

/** Most tokens one tick may ask about - more than a feed page holds, within one DexScreener call. */
export const LIVE_TICK_MAX_TOKENS = 30;

/**
 * How old a reading the tick will hand back without first looking again. Just under the
 * dashboard's 10s tick, so every tick of an open page finds the previous reading due.
 */
const LIVE_TICK_MAX_AGE_MS = 8_000;

/**
 * How long a tick waits for a lookup before answering with what it has. DexScreener usually
 * answers in 150-450ms; a slow one must not hold the response, and its numbers land on the next
 * tick anyway.
 */
const LIVE_TICK_WAIT_MS = 2_500;

const LIVE_TICK_RATE_LIMIT = { max: 40, timeWindow: "1 minute" };

/**
 * How long one read of a token's live columns answers other ticks. Every open Live tab ticks
 * every 10s for much the same tokens, and this route was ~45% of the API's requests, each reading
 * the rows again. Two seconds is far inside the tick, so a viewer never sees a figure older than
 * they would have; a refresh this process makes replaces the entries at once.
 */
const LIVE_ROW_SHARE_MS = 2_000;
/** Tokens held; a few feed pages' worth across every viewer, so this is never reached in practice. */
const LIVE_ROWS_MAX = 5_000;

type LiveRow = {
  id: string;
  mintAddress: string;
  liveMarketCapUsd: number | null;
  livePriceUsd: number | null;
  liveDataAt: Date | null;
};
const liveRows = new Map<string, { row: LiveRow; at: number }>();

function holdLiveRows(rows: LiveRow[], at: number): void {
  for (const row of rows) {
    liveRows.delete(row.id);
    liveRows.set(row.id, { row, at });
  }
  while (liveRows.size > LIVE_ROWS_MAX) {
    const oldest = liveRows.keys().next().value;
    if (oldest === undefined) break;
    liveRows.delete(oldest);
  }
}

/** Test seam: forget the shared readings. */
export function clearLiveRows(): void {
  liveRows.clear();
}

const tickQuerySchema = z.object({
  tokens: z
    .string()
    .transform((v) => [...new Set(v.split(",").filter(Boolean))])
    .pipe(z.array(z.string().min(1).max(64)).min(1).max(LIVE_TICK_MAX_TOKENS)),
});

/**
 * How many distinct tokens one account may mark as viewed per window. The worker refreshes only
 * the most recently viewed tokens (LIVE_PRICE_MAX_TRACKED, 150), so one account ticking hundreds
 * of ids could hold every slot and starve other viewers' cards and paid lookups of their scans
 * (security audit 2026-10-16, inputs F2). A few open tabs of 30 fit well under it.
 */
const VIEW_STAMP_WINDOW_MS = 5 * 60_000;
const VIEW_STAMPS_PER_USER = 120;
const VIEW_STAMP_USERS_MAX = 10_000;
const stampsByUser = new Map<string, { at: number; ids: Set<string> }>();

/** The ids this account may stamp now (those it already stamped this window, then new ones up to the cap). */
export function allowViewStamps(userKey: string, ids: string[], now = Date.now()): string[] {
  let entry = stampsByUser.get(userKey);
  stampsByUser.delete(userKey);
  if (!entry || now - entry.at > VIEW_STAMP_WINDOW_MS) entry = { at: now, ids: new Set() };
  stampsByUser.set(userKey, entry);
  while (stampsByUser.size > VIEW_STAMP_USERS_MAX) {
    const oldest = stampsByUser.keys().next().value;
    if (oldest === undefined) break;
    stampsByUser.delete(oldest);
  }
  const seen = entry.ids;
  return ids.filter((id) => {
    if (seen.has(id)) return true;
    if (seen.size >= VIEW_STAMPS_PER_USER) return false;
    seen.add(id);
    return true;
  });
}

/** Test seam: forget the per-account stamp windows. */
export function clearViewStampWindows(): void {
  stampsByUser.clear();
}

/**
 * How many distinct bubble maps one account may keep on the fast holder re-read. The worker
 * watches the 50 most recently stamped coins (watchedHolders.ts MAX_WATCHED). One account opening
 * token after token used to stamp all 50 (review 2026-10-21). Four open maps fit a few tabs.
 *
 * The cap is the four maps polled most recently, not the first four of a two-minute window
 * (user ask 2026-10-21). A fifth distinct mint is stamped, and the oldest of the four is
 * released. A map not polled for HOLDER_WATCH_WINDOW_MS is released too. The caller clears
 * holdersViewedAt for a released mint only when no account still holds it, so one account cannot
 * leave stamps behind for the worker's whole window after it has moved on.
 */
const HOLDER_WATCH_WINDOW_MS = 2 * 60_000;
export const HOLDER_WATCHES_PER_USER = 4;
/** mint -> the last poll that counted it. Insertion order is oldest first. */
const holderWatchesByUser = new Map<string, Map<string, number>>();

/** A bubble map this call dropped. `at` is the poll that last stamped it. */
export interface ReleasedHolderWatch {
  mint: string;
  at: number;
}

function holderWatchHeld(mint: string): boolean {
  for (const watches of holderWatchesByUser.values()) {
    if (watches.has(mint)) return true;
  }
  return false;
}

/**
 * Keeps `mint` among this account's four newest bubble maps. Always stamps `mint`. `released` is
 * the maps this call dropped that no account still holds, oldest first.
 */
export function allowHolderWatch(
  userKey: string,
  mint: string,
  now = Date.now(),
): { stamp: true; released: ReleasedHolderWatch[] } {
  let watches = holderWatchesByUser.get(userKey);
  holderWatchesByUser.delete(userKey);
  if (!watches) watches = new Map();
  holderWatchesByUser.set(userKey, watches);
  const dropped: ReleasedHolderWatch[] = [];
  while (holderWatchesByUser.size > VIEW_STAMP_USERS_MAX) {
    const oldestUser = holderWatchesByUser.keys().next().value;
    // This account was just moved to the end, so it is not the one to drop.
    if (oldestUser === undefined || oldestUser === userKey) break;
    const gone = holderWatchesByUser.get(oldestUser);
    holderWatchesByUser.delete(oldestUser);
    if (!gone) continue;
    for (const [goneMint, at] of gone) dropped.push({ mint: goneMint, at });
  }
  for (const [held, at] of watches) {
    if (now - at > HOLDER_WATCH_WINDOW_MS) {
      watches.delete(held);
      dropped.push({ mint: held, at });
    }
  }
  if (watches.has(mint)) {
    watches.delete(mint);
  } else if (watches.size >= HOLDER_WATCHES_PER_USER) {
    const oldest = watches.keys().next().value;
    if (oldest !== undefined) {
      dropped.push({ mint: oldest, at: watches.get(oldest)! });
      watches.delete(oldest);
    }
  }
  watches.set(mint, now);
  const released = dropped.filter((row) => !holderWatchHeld(row.mint));
  return { stamp: true, released };
}

/** Test seam: forget the per-account bubble-map windows. */
export function clearHolderWatchWindows(): void {
  holderWatchesByUser.clear();
}

/**
 * The live tick: current market data for the tokens on an open page, seconds old.
 *
 * Before this, "Now" on a card was as fresh as the last full feed poll (every 30s) carrying the
 * last worker refresh (every 60s) - up to 90s behind, ~45s on average, on a product whose alerts
 * are graded on a one-hour window. The full feed is the wrong thing to poll faster: it is a dozen
 * queries for rows that rarely change. This is one indexed read of a few columns, plus a lookup
 * shared with every other reader of the same tokens, so the dashboard can afford it every 10s.
 *
 * Also counts as viewing the tokens (Token.lastViewedAt), so the worker keeps refreshing them
 * while the page stays open.
 */
export async function registerLiveRoutes(
  app: FastifyInstance,
  opts: {
    liveRefresher: OnDemandLiveRefresher;
    viewStamps: ViewStampBuffer;
    /** Where a curve reading raises the recorded peak of matches and calls - see writeLiveMarketData. */
    peakWindowDays?: number;
  },
) {
  // Same gate as the feeds these numbers belong to.
  app.addHook("preHandler", app.authenticateSubscriber);

  // The dashboard ticks every 10 seconds; a few tabs fit under this. Each tick's lookup spends the
  // refresher's shared upstream budget, so one client can't burn it for everyone by ticking fast.
  app.get("/market", { config: { rateLimit: LIVE_TICK_RATE_LIMIT } }, async (request, reply) => {
    const parsed = tickQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const ids = parsed.data.tokens;
    const readRows = async (want: string[]): Promise<LiveRow[]> => {
      if (want.length === 0) return [];
      const rows = await prisma.token.findMany({
        where: { id: { in: want } },
        select: { id: true, mintAddress: true, liveMarketCapUsd: true, livePriceUsd: true, liveDataAt: true },
      });
      holdLiveRows(rows, Date.now());
      return rows;
    };
    // Tokens another viewer's tick read a moment ago come from that read; only the rest are read.
    const read = async (shared: boolean): Promise<LiveRow[]> => {
      if (!shared) return readRows(ids);
      const cutoff = Date.now() - LIVE_ROW_SHARE_MS;
      const held: LiveRow[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const entry = liveRows.get(id);
        if (entry && entry.at > cutoff) held.push(entry.row);
        else missing.push(id);
      }
      return [...held, ...(await readRows(missing))];
    };

    let rows = await read(true);
    const stampIds = rows.map((r) => r.id);
    opts.viewStamps.record(request.user ? allowViewStamps(request.user.userId, stampIds) : stampIds);
    // Coins still on their Pump.fun curve are priced from it, to the block, where DexScreener runs
    // 45-60 s behind the market; they stay out of the DexScreener lookup once a read has found them
    // there. The rest (graduated, not Pump.fun, not read yet) take DexScreener's figure as before.
    const curves = liveCurves();
    const [refreshed, quotes] = await Promise.all([
      opts.liveRefresher.refreshAndWait(
        rows.filter((r) => !curves.onCurve(r.mintAddress)),
        { maxAgeMs: LIVE_TICK_MAX_AGE_MS, timeoutMs: LIVE_TICK_WAIT_MS, userKey: request.user?.userId },
      ),
      curves.quotes(
        rows.map((r) => r.mintAddress),
        LIVE_TICK_WAIT_MS,
      ),
    ]);
    if (refreshed) rows = await read(false);
    const now = Date.now();
    if (quotes.size > 0) rows = withCurveQuotes(rows, quotes, now, opts.peakWindowDays);

    reply.header("Cache-Control", "no-store");
    const withReading = rows.filter((r) => r.liveDataAt !== null && r.liveMarketCapUsd !== null);
    if (withReading.length > 0) {
      opts.liveRefresher.noteServed(Math.max(...withReading.map((r) => now - r.liveDataAt!.getTime())));
    }
    return {
      at: new Date(now).toISOString(),
      tokens: withReading.map((r) => ({
        id: r.id,
        marketCapUsd: r.liveMarketCapUsd,
        priceUsd: r.livePriceUsd,
        at: r.liveDataAt,
        ...(quotes.has(r.mintAddress) ? { source: "curve" as const } : {}),
      })),
    };
  });
}

/**
 * The tick's rows with each curve-priced coin's reading laid over DexScreener's. A row whose stored
 * reading is due (as old as the tick's bound) also has the curve's written to Token.live*, without
 * holding the answer, so the feed, the worker and the peaks see it too; a row another viewer's tick
 * wrote a moment ago is not written again.
 */
export function withCurveQuotes(
  rows: LiveRow[],
  quotes: ReadonlyMap<string, { marketCapUsd: number; priceUsd: number; at: number }>,
  now: number,
  peakWindowDays?: number,
): LiveRow[] {
  const due: { id: string; mintAddress: string }[] = [];
  const live: { mintAddress: string; marketCapUsd: number; priceUsd: number }[] = [];
  const seenAt = new Map<string, Date>();
  const out = rows.map((r) => {
    const q = quotes.get(r.mintAddress);
    if (!q) return r;
    if (r.liveDataAt === null || now - r.liveDataAt.getTime() >= LIVE_TICK_MAX_AGE_MS) {
      due.push({ id: r.id, mintAddress: r.mintAddress });
      live.push({ mintAddress: r.mintAddress, marketCapUsd: q.marketCapUsd, priceUsd: q.priceUsd });
      seenAt.set(r.mintAddress, new Date(q.at));
    }
    return { ...r, liveMarketCapUsd: q.marketCapUsd, livePriceUsd: q.priceUsd, liveDataAt: new Date(q.at) };
  });
  if (due.length > 0) {
    holdLiveRows(
      out.filter((r) => seenAt.has(r.mintAddress)),
      now,
    );
    void writeLiveMarketData(due, live, { seenAt, fetchedAt: new Date(now), peakWindowDays }).catch(
      () => undefined,
    );
  }
  return out;
}
