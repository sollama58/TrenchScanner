import {
  chunkBars,
  CoinGeckoBudgetSpentError,
  createLogger,
  HttpError,
  MINUTE_CANDLE_PAGE,
  parseGeckoOhlcv,
  prisma,
  PUMP_SUPPLY_TOKENS,
  RateGateDeadlineError,
  readCandleChunks,
  saveCandleChunks,
  type CandleChunkRow,
  type GeckoTerminalClient,
  type MinuteCandle,
  type PumpFunClient,
} from "@trenchscanner/core";
import { poolsOf, type BackfillToken } from "./candleBackfill.js";

const logger = createLogger("minute-candles");

/** What the Peak and re-grade jobs read a coin's minute candles through. */
export type MinuteCandleReader = Pick<PumpFunClient, "minuteCandles" | "fiveMinuteCandles">;

/**
 * The url of the 429 a read gets when the day's CoinGecko budget for Peaks and re-grades is spent
 * (coingeckoBudget.ts): a run stops there like on any 429, and says why.
 */
export const COINGECKO_DAY_SPENT = "coingecko-daily-budget";

/**
 * No source could say whether the coin has candles: Pump.fun was paused or failed, the store holds
 * nothing and GeckoTerminal was absent or knew none of the coin's pools. Callers retry later; it is
 * not Pump.fun's "not a Pump.fun coin" null, which the Peaks job used to take it for and parked the
 * coin for good (28 of 30 coins a run on 2026-10-23, with the trainer missing the CoinGecko key).
 */
export class CandlesUnavailableError extends Error {
  constructor(mint: string, why: string) {
    super(`no candle source could answer for ${mint}: ${why}`);
    this.name = "CandlesUnavailableError";
  }
}

/** After Pump.fun refuses a read (403), its candles are not asked again for this long. */
export const PUMP_REFUSED_PAUSE_MS = 10 * 60_000;
/** How long a GeckoTerminal page may wait for its budget before the read counts as throttled. */
const GECKO_WAIT_MS = 10_000;
const FIVE_MIN_SHIFT_MS = 4 * 60_000;
const MINUTE_MS = 60_000;
/** How far back the candle store is read for a coin: the Peaks' tracking window and a day. */
export const STORE_LOOKBACK_MS = 15 * 86_400_000;
/**
 * The store's candles are answer enough while they reach to within this of now: the curve tape
 * saves a followed coin's bars every minute. Older, the newest stretch is topped up from
 * GeckoTerminal with one page.
 */
export const STORE_FRESH_MS = 5 * 60_000;

export interface MinuteCandleReaderDeps {
  pumpFun: MinuteCandleReader;
  /** Null leaves Pump.fun the only source, as before. */
  gecko: Pick<GeckoTerminalClient, "poolMinuteCandles"> | null;
  /** The coin's Token fields poolsOf reads; null for a coin the database doesn't hold. */
  token?: (mint: string) => Promise<BackfillToken | null>;
  /** The coin's stored candle chunks reaching into [from, to) (core's readCandleChunks). */
  store?: (mint: string, from: number, to: number) => Promise<CandleChunkRow[]>;
  /** Where a GeckoTerminal top-up page is saved (core's saveCandleChunks). */
  save?: (rows: CandleChunkRow[]) => Promise<unknown>;
  now?: () => number;
}

/** A type, not an interface, so it fits a job's run meta. */
export type MinuteCandleReaderStats = {
  pump: number;
  /** Answered from the candle store alone, no upstream call. */
  store: number;
  gecko: number;
  pumpRefused: number;
};

/**
 * A coin's minute candles from Pump.fun, else from the candle store, else from GeckoTerminal
 * (CoinGecko's on-chain API with COINGECKO_API_KEY) on the coin's own pools. Pump.fun's Cloudflare
 * began answering every candle read from Render 403 on 2026-10-23, and the Peaks and re-grades that
 * read only Pump.fun stalled.
 *
 * The store first (user decision 2026-10-23, "Read Peaks from our candle store"): the curve tape
 * saves a young coin's 1-second bars every minute and the backfill every called coin's minutes, so
 * most coins' history is already held, and reading it from CoinGecko again cost a paid call per
 * coin per read (~75 a minute for Peaks). Stored bars are folded into minutes (each minute's last
 * close) and are the answer while they reach to within STORE_FRESH_MS of now. Older, one
 * GeckoTerminal page on the coin's own pool fills the newest stretch and is saved, so the next
 * read starts from there. A coin the store holds nothing for is read from GeckoTerminal as below.
 *
 * GeckoTerminal's newest page on each pool (poolsOf: the coin's pair, then a Pump.fun coin's
 * PumpSwap pool and bonding curve) is merged into Pump.fun's shape: USD closes, oldest first, the
 * newest MINUTE_CANDLE_PAGE minutes that had a trade, a minute with no trade left out. A pool's
 * page that is already full is the newest it can be, so the older pools are not asked. A coin
 * neither source knows is null. A budget wait reads as Pump.fun's 429, which every caller already
 * takes as "stop this run", and a 403 pauses Pump.fun for PUMP_REFUSED_PAUSE_MS so each read
 * doesn't spend a call on it first.
 */
export function minuteCandleReader(deps: MinuteCandleReaderDeps): MinuteCandleReader & {
  takeStats(): MinuteCandleReaderStats;
} {
  const now = deps.now ?? Date.now;
  const tokenOf = deps.token ?? readToken;
  let refusedUntil = 0;
  let stats: MinuteCandleReaderStats = { pump: 0, store: 0, gecko: 0, pumpRefused: 0 };

  const storeRead = deps.store ?? readCandleChunks;
  const save = deps.save ?? saveCandleChunks;

  const read = async (mint: string, five: boolean): Promise<MinuteCandle[] | null> => {
    const pump = () => (five ? deps.pumpFun.fiveMinuteCandles(mint) : deps.pumpFun.minuteCandles(mint));
    const gecko = deps.gecko;
    let pumpError: unknown = null;
    /** Pump.fun answered, and said the coin is not one of its own. */
    let pumpSaysNoCoin = false;
    if (now() >= refusedUntil) {
      try {
        const candles = await pump();
        if (candles !== null) {
          stats.pump += 1;
          return candles;
        }
        // Not a Pump.fun coin: the store or its own pair on GeckoTerminal may still have it.
        pumpSaysNoCoin = true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          refusedUntil = now() + PUMP_REFUSED_PAUSE_MS;
          stats.pumpRefused += 1;
          logger.warn("Pump.fun refused a candle read; the candle store for a while", { mint });
        } else if (!gecko) {
          // Without GeckoTerminal a 429 or an outage is the caller's, as before.
          throw err;
        } else if (!(err instanceof HttpError && err.status === 429)) {
          logger.warn("Pump.fun candle read failed; trying the store and GeckoTerminal", {
            mint,
            error: String(err),
          });
        }
        pumpError = err;
      }
    }

    const nowMs = now();
    const stepMs = five ? 5 * MINUTE_MS : MINUTE_MS;
    const chunks = await storeRead(mint, nowMs - STORE_LOOKBACK_MS, nowMs).catch((err: unknown) => {
      logger.warn("candle store read failed", { mint, error: String(err) });
      return [] as CandleChunkRow[];
    });
    const stored = storedCloses(chunks, stepMs);
    if (stored.closes.size > 0 && (nowMs - stored.coverEnd <= STORE_FRESH_MS || !gecko)) {
      stats.store += 1;
      return toCandles(stored.closes, five);
    }
    // Only Pump.fun's own answer says a coin has no candles; without it, nothing answering is a
    // read to retry, not a verdict.
    const none = (why: string): null => {
      if (pumpSaysNoCoin) return null;
      throw new CandlesUnavailableError(mint, why);
    };
    if (!gecko) {
      // Nothing stored and nothing else to ask: Pump.fun's refusal stands, as before.
      if (pumpError) throw pumpError;
      return none("Pump.fun paused after a 403, the store empty, no CoinGecko key");
    }
    const token = await tokenOf(mint);
    const pools = poolsOf(mint, token ?? { launchpad: null, launchedAt: null, pairAddress: null });
    if (pools.length === 0)
      return stored.closes.size > 0 ? toCandles(stored.closes, five) : none("no pools to ask");
    if (stored.closes.size === 0) {
      const candles = await geckoCandles(gecko, mint, pools, five ? 5 : 1, nowMs);
      if (candles !== null) stats.gecko += 1;
      return candles ?? none("GeckoTerminal knows none of the coin's pools");
    }
    // The store's history, its newest stretch from one page on the coin's own pool.
    for (const pool of pools) {
      const body = await geckoPage(gecko, pool, mint, nowMs, five ? 5 : 1);
      if (body === null) continue;
      stats.gecko += 1;
      const bars = parseGeckoOhlcv(body);
      if (!five && bars.length > 0) {
        const closed = bars.filter((b) => b.t + MINUTE_MS <= nowMs);
        if (closed.length > 0) {
          // As the backfill saves a page: it vouches only to its newest bar's end.
          const rows = chunkBars(mint, 60, "gecko", closed, {
            from: closed[0]!.t,
            to: Math.min(Math.floor(nowMs / MINUTE_MS) * MINUTE_MS, closed[closed.length - 1]!.t + MINUTE_MS),
          });
          await Promise.resolve(save(rows)).catch((err: unknown) =>
            logger.warn("top-up candles not saved", { mint, error: String(err) }),
          );
        }
      }
      for (const b of bars) {
        const bucket = Math.floor(b.t / stepMs) * stepMs;
        // The store's minutes stand; the page adds the ones it doesn't hold, the newest above all.
        if (!stored.closes.has(bucket)) stored.closes.set(bucket, b.c / PUMP_SUPPLY_TOKENS);
      }
      break;
    }
    return toCandles(stored.closes, five);
  };

  return {
    minuteCandles: (mint) => read(mint, false),
    fiveMinuteCandles: (mint) => read(mint, true),
    takeStats() {
      const out = stats;
      stats = { pump: 0, store: 0, gecko: 0, pumpRefused: 0 };
      return out;
    },
  };
}

/**
 * Exported for tests. The newest page of each of `pools` in turn, merged as above; null when
 * GeckoTerminal knows none of them.
 */
export async function geckoCandles(
  gecko: Pick<GeckoTerminalClient, "poolMinuteCandles">,
  mint: string,
  pools: readonly string[],
  aggregate: 1 | 5,
  nowMs: number,
): Promise<MinuteCandle[] | null> {
  const byStart = new Map<number, number>();
  let known = false;
  for (const pool of pools) {
    const body = await geckoPage(gecko, pool, mint, nowMs, aggregate);
    if (body === null) continue;
    known = true;
    // Supply 1 leaves GeckoTerminal's price per token, Pump.fun's close.
    const bars = parseGeckoOhlcv(body, 1);
    // The first pool named is the coin's own: a minute it has wins over a later pool's.
    for (const b of bars) if (!byStart.has(b.t)) byStart.set(b.t, b.c);
    if (bars.length >= MINUTE_CANDLE_PAGE) break;
  }
  if (!known) return null;
  // Pump.fun's five-minute candle is put on its last minute (fiveMinuteCandles); this is the same.
  const shift = aggregate === 5 ? FIVE_MIN_SHIFT_MS : 0;
  return [...byStart]
    .sort((a, b) => a[0] - b[0])
    .slice(-MINUTE_CANDLE_PAGE)
    .map(([startMs, close]) => ({ startMs: startMs + shift, close }));
}

/** One GeckoTerminal page; a budget wait reads as a 429 (see minuteCandleReader). */
async function geckoPage(
  gecko: Pick<GeckoTerminalClient, "poolMinuteCandles">,
  pool: string,
  mint: string,
  nowMs: number,
  aggregate: 1 | 5,
): Promise<unknown> {
  try {
    return await gecko.poolMinuteCandles(pool, mint, nowMs, GECKO_WAIT_MS, aggregate);
  } catch (err) {
    if (err instanceof CoinGeckoBudgetSpentError) {
      throw new HttpError(429, COINGECKO_DAY_SPENT, err.message);
    }
    if (err instanceof RateGateDeadlineError) {
      throw new HttpError(429, "geckoterminal", "GeckoTerminal budget spent (rate gate)");
    }
    throw err;
  }
}

/**
 * Exported for tests. Stored bars folded into `stepMs` buckets: each bucket's close is its latest
 * bar's (a minute of 1-second bars closes where its last second did, as Pump.fun's minute does),
 * as a price per token. Minute-or-finer chunks only, and 5-minute ones for 5-minute buckets.
 * `coverEnd`: how far the chunks used reach.
 */
export function storedCloses(
  chunks: readonly CandleChunkRow[],
  stepMs: number,
): { closes: Map<number, number>; coverEnd: number } {
  const latest = new Map<number, { t: number; c: number }>();
  let coverEnd = -Infinity;
  for (const chunk of chunks) {
    if (chunk.res * 1_000 > stepMs) continue;
    coverEnd = Math.max(coverEnd, chunk.coverTo);
    for (const b of chunk.bars) {
      if (!(b.c > 0) || !Number.isFinite(b.c)) continue;
      const bucket = Math.floor(b.t / stepMs) * stepMs;
      const held = latest.get(bucket);
      if (!held || b.t >= held.t) latest.set(bucket, { t: b.t, c: b.c });
    }
  }
  const closes = new Map<number, number>();
  for (const [bucket, { c }] of latest) closes.set(bucket, c / PUMP_SUPPLY_TOKENS);
  return { closes, coverEnd };
}

/** Buckets as Pump.fun's candles, oldest first; a 5-minute one on its last minute. */
function toCandles(closes: Map<number, number>, five: boolean): MinuteCandle[] {
  const shift = five ? FIVE_MIN_SHIFT_MS : 0;
  return [...closes]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, close]) => ({ startMs: startMs + shift, close }));
}

async function readToken(mint: string): Promise<BackfillToken | null> {
  return prisma.token.findUnique({
    where: { mintAddress: mint },
    select: { launchpad: true, launchedAt: true, pairAddress: true },
  });
}
