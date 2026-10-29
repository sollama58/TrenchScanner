import { PUMPFUN_LAUNCHPAD, STONKS_LAUNCHPAD } from "../launchpads.js";
import { launchLabPoolOf } from "../datasources/launchLab.js";
import { pumpCurveAddressOf } from "../datasources/pumpLaunch.js";
import { pumpSwapPoolOf } from "../datasources/pumpSwapPool.js";
import { WRAPPED_SOL_MINT } from "../venueAccounts.js";
import { chunkBars, runCoversOn, type CandleChunkRow, type StoredBar } from "./candleChunk.js";

/**
 * GeckoTerminal's minute pages as candle store rows, shared by the worker's backfill
 * (candleBackfill.ts) and the API's top-up on a chart's open (apps/api candleStore.ts), so both
 * read a coin's pools in the same order and vouch for the same quiet minutes.
 */

const MINUTE_MS = 60_000;
/** How long a coin's stored pairAddress is kept current by the scan (its watchlist, 24 h). */
const PAIR_TRUSTED_MS = 24 * 3_600_000;

/**
 * GeckoTerminal's newest minutes can trail a read by a minute or two. The page read from now on
 * the coin's own pair vouches for the minutes after its newest bar as quiet up to this long ago:
 * a coin that stopped trading hours ago draws flat at its last price from then, not as "No data
 * recorded" (user report 2026-10-23). A minute reported later still lands: the next top-up's page
 * is merged into the stored chunk (core's saveCandleChunks).
 */
export const GECKO_SETTLE_MS = 3 * MINUTE_MS;

/** The coin's Token fields its pools are worked out from. */
export interface BackfillToken {
  launchpad: string | null;
  launchedAt: Date | null;
  pairAddress: string | null;
  /** What its pair is quoted in (Token.quoteMint): finds a Stonks coin's LaunchLab pool. Unset: SOL. */
  quoteMint?: string | null;
}

/** A Pump.fun coin: its launchpad says so, or its address does. */
export function isPumpCoin(mint: string, token: Pick<BackfillToken, "launchpad">): boolean {
  return token.launchpad === PUMPFUN_LAUNCHPAD || mint.endsWith("pump");
}

/**
 * The pools a coin's minute history is paged on, in order: its own pair (Token.pairAddress, the one
 * its card is priced on), then for a Pump.fun coin its PumpSwap pool and its bonding curve, which is
 * where a graduated coin's history before the pool lives. A side pool is never picked by depth
 * (charts audit CH-7: a $6 Meteora pool's price and history are not the coin's).
 */
export function poolsOf(mint: string, token: BackfillToken, now = Date.now()): string[] {
  const out: (string | null)[] = [];
  if (isPumpCoin(mint, token)) {
    const curve = pumpCurveAddressOf(mint) ?? null;
    // A coin still priced on its curve has not graduated: its PumpSwap pool doesn't exist yet, and
    // asking for it cost a paid CoinGecko call per coin that answered nothing (credit audit
    // 2026-10-23: about half the backfill's calls). The curve is still asked. Only the scan keeps
    // pairAddress current, and only while the coin is on its watchlist, so past PAIR_TRUSTED_MS a
    // curve address may be stale: a coin that graduated later still has its pool asked (TB-1).
    // The pool goes first then: the curve has bars too, and a reader stops at the first pool that
    // answers.
    const pairTrusted = token.launchedAt !== null && now - token.launchedAt.getTime() < PAIR_TRUSTED_MS;
    const pool = pumpSwapPoolOf(mint) ?? null;
    if (token.pairAddress !== curve) out.push(token.pairAddress, pool);
    else if (!pairTrusted) out.push(pool);
    out.push(curve);
  } else {
    out.push(token.pairAddress);
    // A Stonks coin's LaunchLab curve: DexScreener lists none, so on its curve a Stonks coin has no
    // pairAddress and had no minute history at all (user report 2026-10-25). After graduation it
    // holds the coin's history before the Raydium pool, as a Pump.fun coin's curve does.
    if (token.launchpad === STONKS_LAUNCHPAD)
      out.push(launchLabPoolOf(mint, token.quoteMint ?? WRAPPED_SOL_MINT) ?? null);
  }
  return [...new Set(out.filter((p): p is string => !!p))];
}

/**
 * The store rows of one GeckoTerminal minute page (`bars`, parsed, oldest first) read for
 * everything before `cursor`; `fromNow`: the coin's newest page, read from now. Only closed minutes
 * are saved. GeckoTerminal leaves a minute with no trade out, so the minutes between the page's
 * newest bar and the cursor were quiet: the page vouches for them (prod 2026-10-23: a page ending
 * one quiet minute before the next page's start left its covers apart). The newest page vouches to
 * its newest bar's end or GECKO_SETTLE_MS ago, whichever is later, so a minute GeckoTerminal is
 * late with is asked again by the next top-up rather than stored as quiet. Each chunk's cover runs
 * on to the next one's start (runCoversOn). `otherPool`: the cursor is where another pool's history
 * began, so the page vouches only to its newest bar's end: a curve's silence after graduation is not
 * the coin's (chart audit 2026-10-29, D2: graduation to the pool's oldest page was drawn flat over
 * the pool's trading).
 */
export function geckoPageRows(
  mint: string,
  bars: readonly StoredBar[],
  cursor: number,
  now: number,
  fromNow: boolean,
  otherPool = false,
): CandleChunkRow[] {
  if (bars.length === 0) return [];
  const closed = bars.filter((b) => b.t + MINUTE_MS <= now);
  const newestEnd = closed.length > 0 ? closed[closed.length - 1]!.t + MINUTE_MS : bars[0]!.t;
  const settled = Math.floor((now - GECKO_SETTLE_MS) / MINUTE_MS) * MINUTE_MS;
  const quietTo = fromNow ? Math.max(newestEnd, settled) : otherPool ? newestEnd : cursor;
  const to = Math.min(cursor, Math.floor(now / MINUTE_MS) * MINUTE_MS, quietTo);
  return runCoversOn(chunkBars(mint, 60, "gecko", closed, { from: bars[0]!.t, to }), to);
}

/**
 * The worker backfill's GeckoTerminal pages a minute (candleBackfill.ts): its own setting, or a
 * share of the paid plan's calls, or a few on the free API. The API's chart reads it to tell a
 * waiting chart when its history lands (candles' `backfill`).
 */
export function candleBackfillPerMinute(env: {
  CANDLE_BACKFILL_GECKO_PER_MINUTE?: number | undefined;
  COINGECKO_API_KEY?: string | undefined;
  COINGECKO_REQUESTS_PER_MINUTE: number;
}): number {
  return (
    env.CANDLE_BACKFILL_GECKO_PER_MINUTE ??
    (env.COINGECKO_API_KEY ? Math.floor((env.COINGECKO_REQUESTS_PER_MINUTE * 0.4) / 3) : 4)
  );
}
