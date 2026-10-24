import {
  CANDLE_BACKFILL_FEATURE,
  createLogger,
  geckoPageRows,
  parseGeckoOhlcv,
  poolsOf,
  saveCandleChunks,
  withOwnApiFeature,
  type BackfillToken,
  type CandleChunkRow,
  type GeckoTerminalClient,
} from "@trenchscanner/core";

const logger = createLogger("candle-top-up");

/**
 * The chart's own top-up when it opens (user ask 2026-10-24: "30 s is unacceptable"): a coin's
 * newest page with a stretch nobody recorded (past its 1-second follow, or never followed) used to
 * wait for the worker's backfill queue and then the chart's next poll, 30 s at 1m, before its
 * minutes showed. The API now reads the coin's GeckoTerminal minute page from now itself (one
 * call: its newest 1,000 minutes), saves it to the store as the worker's backfill would
 * (core's geckoPageRows), and answers with it, inside the same request. The worker's backfill
 * still pages back past those 1,000 minutes.
 */

/** A hole at least this long, in the newest page, is worth a top-up. */
export const TOP_UP_HOLE_MS = 2 * 60_000;
/** A page reaches this far back, so only holes inside it are filled by one. */
const PAGE_REACH_MS = 1_000 * 60_000;
/** The request waits this long at most for the page; past it the save lands for the next poll. */
export const TOP_UP_WAIT_MS = 4_000;
/** A coin is topped up at most this often from one process after a page saved bars... */
const AGAIN_AFTER_MS = 60_000;
/** ...and after a page that brought nothing (an unknown pool, a failed read). */
const AGAIN_AFTER_EMPTY_MS = 5 * 60_000;
const MAX_COINS = 5_000;

/**
 * Exported for tests. Whether a newest page's holes call for a top-up: one of TOP_UP_HOLE_MS or
 * longer that a page read from now reaches, or no bars at all.
 */
export function wantsTopUp(
  answer: { bars: readonly unknown[]; holes?: readonly (readonly [number, number])[] },
  now = Date.now(),
): boolean {
  if (answer.bars.length === 0) return true;
  return (answer.holes ?? []).some(([a, b]) => b - a >= TOP_UP_HOLE_MS && b > now - PAGE_REACH_MS);
}

export interface TopUpDeps {
  gecko: Pick<GeckoTerminalClient, "poolMinuteCandles">;
  save?: (rows: CandleChunkRow[]) => Promise<unknown>;
  now?: () => number;
}

const nextAt = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Reads and saves the coin's newest GeckoTerminal minute page, on its pools in the backfill's
 * order (the first that answers with bars). Resolves true once bars were saved, false otherwise
 * (throttled, nothing found, failed); never rejects. One read per coin at a time.
 */
export function topUpNow(mint: string, token: BackfillToken, deps: TopUpDeps): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const held = inFlight.get(mint);
  if (held) return held;
  if (now < (nextAt.get(mint) ?? 0)) return Promise.resolve(false);
  const run = withOwnApiFeature(CANDLE_BACKFILL_FEATURE, () => read(mint, token, deps, now))
    .catch((err: unknown) => {
      logger.warn("chart top-up failed", { mint, error: String(err) });
      return false;
    })
    .then((saved) => {
      if (nextAt.size >= MAX_COINS) nextAt.clear();
      nextAt.set(mint, now + (saved ? AGAIN_AFTER_MS : AGAIN_AFTER_EMPTY_MS));
      return saved;
    })
    .finally(() => inFlight.delete(mint));
  inFlight.set(mint, run);
  return run;
}

async function read(mint: string, token: BackfillToken, deps: TopUpDeps, now: number): Promise<boolean> {
  for (const pool of poolsOf(mint, token, now).slice(0, 2)) {
    const body = await deps.gecko.poolMinuteCandles(pool, mint, now, TOP_UP_WAIT_MS);
    const bars = body === null ? [] : parseGeckoOhlcv(body);
    if (bars.length === 0) continue;
    const rows = geckoPageRows(mint, bars, Math.floor(now / 60_000) * 60_000, now, true);
    if (rows.length === 0) return false;
    await (deps.save ?? saveCandleChunks)(rows);
    return true;
  }
  return false;
}

/**
 * When the coin's top-up could next bring its newest minutes, in ms from now: 0 while one is
 * reading or none ran yet; null once one ran and the next is held back (it found nothing new to
 * fill the hole with, or saved what there was).
 */
export function topUpDueIn(mint: string): number | null {
  if (inFlight.has(mint)) return 0;
  return nextAt.has(mint) ? null : 0;
}

/** Tests: a clean slate. */
export function resetCandleTopUp(): void {
  nextAt.clear();
  inFlight.clear();
}
