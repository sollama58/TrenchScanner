import {
  BACKFILL_TOP_UP_AFTER_MS,
  chunkBars,
  createLogger,
  requestCandleBackfill,
  saveCandleChunks,
  type CandleChunkRow,
  type CandleRes,
} from "@trenchscanner/core";
import type { CandleFetcher, McapCandle } from "./tokenChart.js";
import { pageCoverEnd } from "./tokenCandles.js";

const logger = createLogger("candle-store");

/**
 * The API's side of the closed-candle store (charts audit 2026-10-22 CH-8, user decision "Store
 * candles + backfill"): the Pump.fun pages the chart caches already read are saved once, chunk by
 * closed chunk, instead of being asked for again forever, and each coin a chart opens is queued for
 * its one-time backfill to launch (the worker's candleBackfill.ts). The newest page of each coin is
 * also kept in memory for GET /tokens/:mint/candles, whose newest stretch is not closed yet.
 *
 * Wraps a cache's fetcher (storingFetcher), so no extra Pump.fun call is made for any of this.
 */

/**
 * Saved chunks remembered with their bar count, so a page read every 30 s writes each closed chunk
 * once, and again only when a later page holds more of its bars (a candle Pump.fun was late with).
 */
const MAX_SAVED_KEYS = 50_000;
/** Chunk rows waiting at most; past it the newest are dropped (a stalled database must not grow memory). */
const MAX_QUEUED = 2_000;
const FLUSH_MS = 5_000;
/** Newest pages kept per width. */
const MAX_PAGES = 300;
/** A coin's backfill is asked for at most this often from one process (a top-up's: its own redo). */
const ASK_EVERY_MS = 60 * 60_000;
const MAX_ASKED = 5_000;

let enabled = true;
const saved = new Map<string, number>();
let queue: CandleChunkRow[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
const pages = new Map<string, { at: number; candles: McapCandle[] }>();
const asked = new Map<string, number>();
let save: (rows: CandleChunkRow[]) => Promise<unknown> = saveCandleChunks;
let ask: (mint: string, redoAfterMs?: number) => Promise<unknown> = (mint, redoAfterMs) =>
  requestCandleBackfill(mint, "chart", Date.now(), redoAfterMs);

/** CANDLE_STORE: off, nothing is written or asked (the newest pages are still kept). */
export function configureCandleStore(opts: { enabled: boolean }): void {
  enabled = opts.enabled;
}

/**
 * `fetcher` (a chart cache's Pump.fun reader of `res`-second candles) with its answers kept: the
 * page as the coin's newest, its closed chunks queued for the store once each, and, for the minute
 * page every open chart reads, the coin's backfill asked for.
 */
export function storingFetcher(fetcher: CandleFetcher, res: CandleRes): CandleFetcher {
  return async (mint) => {
    const candles = await fetcher(mint);
    if (candles?.length) keepPage(mint, res, candles);
    if (res === 60) askBackfill(mint);
    return candles;
  };
}

/** The coin's newest `res` page if read within `maxAgeMs`, with when it was read. */
export function latestPage(
  mint: string,
  res: CandleRes,
  maxAgeMs: number,
  now = Date.now(),
): { at: number; candles: McapCandle[] } | null {
  const page = pages.get(`${res}:${mint}`);
  return page && now - page.at <= maxAgeMs ? page : null;
}

/** Exported for tests. Keeps a page as the coin's newest and queues its unsaved closed chunks. */
export function keepPage(mint: string, res: CandleRes, candles: McapCandle[], now = Date.now()): void {
  const key = `${res}:${mint}`;
  pages.delete(key);
  pages.set(key, { at: now, candles });
  while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
  if (!enabled) return;
  const step = res * 1_000;
  const closed = candles.filter((k) => k.t + step <= now);
  if (closed.length === 0) return;
  // The page holds every trading interval from its first to its newest (pageCoverEnd): no gap
  // inside. Only chunks that end by then are saved, so a minute Pump.fun was late with is never
  // stored as a quiet one.
  const coverTo = Math.floor(pageCoverEnd(candles[candles.length - 1]!.t, res, now) / step) * step;
  const rows = chunkBars(
    mint,
    res,
    "pumpfun",
    closed,
    { from: closed[0]!.t, to: coverTo },
    { onlyClosed: true, now: coverTo },
  );
  for (const row of rows) {
    const id = `${mint}:${res}:${row.startAt}`;
    if ((saved.get(id) ?? 0) >= row.bars.length || queue.length >= MAX_QUEUED) continue;
    if (saved.size >= MAX_SAVED_KEYS) saved.clear();
    saved.set(id, row.bars.length);
    queue.push(row);
  }
  if (queue.length > 0 && !timer) {
    timer = setInterval(() => void flushCandleStore(), FLUSH_MS);
    timer.unref?.();
  }
}

/**
 * Asks for the coin's backfill, once an hour at most from this process. `topUp`: a coin Pump.fun has
 * no candles for, whose newest stretch only the backfill brings (BACKFILL_TOP_UP_AFTER_MS): asked
 * as often as that, and queued again once its last run is that old.
 */
export function askBackfill(mint: string, now = Date.now(), topUp = false): void {
  if (!enabled) return;
  const last = asked.get(mint);
  const every = topUp ? BACKFILL_TOP_UP_AFTER_MS : ASK_EVERY_MS;
  if (last !== undefined && now - last < every) return;
  if (asked.size >= MAX_ASKED) asked.clear();
  asked.set(mint, now);
  void ask(mint, topUp ? BACKFILL_TOP_UP_AFTER_MS : undefined).catch((err: unknown) => {
    asked.delete(mint);
    logger.warn("candle backfill not asked", { mint, error: String(err) });
  });
}

/**
 * Writes the queued chunks in batched inserts (core's saveCandleChunks, one connection). Rows that
 * failed are forgotten as saved, so a later read of the coin queues them again.
 */
export function flushCandleStore(): Promise<void> {
  if (flushing) return flushing;
  if (queue.length === 0) return Promise.resolve();
  const batch = queue;
  queue = [];
  flushing = (async () => {
    try {
      await save(batch);
    } catch (err) {
      for (const row of batch) saved.delete(`${row.mint}:${row.res}:${row.startAt}`);
      logger.warn("candle chunks not saved", { rows: batch.length, error: String(err) });
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Tests: where rows are saved and backfills asked, and a clean slate. */
export function resetCandleStoreForTests(
  opts: {
    save?: (rows: CandleChunkRow[]) => Promise<unknown>;
    ask?: (mint: string, redoAfterMs?: number) => Promise<unknown>;
  } = {},
): void {
  if (timer) clearInterval(timer);
  timer = null;
  flushing = null;
  enabled = true;
  saved.clear();
  queue = [];
  pages.clear();
  asked.clear();
  save = opts.save ?? saveCandleChunks;
  ask = opts.ask ?? ((mint, redoAfterMs) => requestCandleBackfill(mint, "chart", Date.now(), redoAfterMs));
}
