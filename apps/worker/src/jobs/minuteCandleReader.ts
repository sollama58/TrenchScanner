import {
  createLogger,
  HttpError,
  MINUTE_CANDLE_PAGE,
  parseGeckoOhlcv,
  prisma,
  RateGateDeadlineError,
  type GeckoTerminalClient,
  type MinuteCandle,
  type PumpFunClient,
} from "@trenchscanner/core";
import { poolsOf, type BackfillToken } from "./candleBackfill.js";

const logger = createLogger("minute-candles");

/** What the Peak and re-grade jobs read a coin's minute candles through. */
export type MinuteCandleReader = Pick<PumpFunClient, "minuteCandles" | "fiveMinuteCandles">;

/** After Pump.fun refuses a read (403), its candles are not asked again for this long. */
export const PUMP_REFUSED_PAUSE_MS = 10 * 60_000;
/** How long a GeckoTerminal page may wait for its budget before the read counts as throttled. */
const GECKO_WAIT_MS = 10_000;
const FIVE_MIN_SHIFT_MS = 4 * 60_000;

export interface MinuteCandleReaderDeps {
  pumpFun: MinuteCandleReader;
  /** Null leaves Pump.fun the only source, as before. */
  gecko: Pick<GeckoTerminalClient, "poolMinuteCandles"> | null;
  /** The coin's Token fields poolsOf reads; null for a coin the database doesn't hold. */
  token?: (mint: string) => Promise<BackfillToken | null>;
  now?: () => number;
}

/** A type, not an interface, so it fits a job's run meta. */
export type MinuteCandleReaderStats = {
  pump: number;
  gecko: number;
  pumpRefused: number;
};

/**
 * A coin's minute candles from Pump.fun, else from GeckoTerminal (CoinGecko's on-chain API with
 * COINGECKO_API_KEY) on the coin's own pools. Pump.fun's Cloudflare began answering every candle
 * read from Render 403 on 2026-10-23, and the Peaks and re-grades that read only Pump.fun stalled.
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
  let stats: MinuteCandleReaderStats = { pump: 0, gecko: 0, pumpRefused: 0 };

  const read = async (mint: string, five: boolean): Promise<MinuteCandle[] | null> => {
    const pump = () => (five ? deps.pumpFun.fiveMinuteCandles(mint) : deps.pumpFun.minuteCandles(mint));
    const gecko = deps.gecko;
    if (!gecko) {
      const candles = await pump();
      stats.pump += 1;
      return candles;
    }
    if (now() >= refusedUntil) {
      try {
        const candles = await pump();
        if (candles !== null) {
          stats.pump += 1;
          return candles;
        }
        // Not a Pump.fun coin: its own pair may still be on GeckoTerminal.
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          refusedUntil = now() + PUMP_REFUSED_PAUSE_MS;
          stats.pumpRefused += 1;
          logger.warn("Pump.fun refused a candle read; GeckoTerminal for a while", { mint });
        } else if (!(err instanceof HttpError && err.status === 429)) {
          logger.warn("Pump.fun candle read failed; trying GeckoTerminal", { mint, error: String(err) });
        }
      }
    }
    const token = await tokenOf(mint);
    const pools = poolsOf(mint, token ?? { launchpad: null, launchedAt: null, pairAddress: null });
    if (pools.length === 0) return null;
    const candles = await geckoCandles(gecko, mint, pools, five ? 5 : 1, now());
    if (candles !== null) stats.gecko += 1;
    return candles;
  };

  return {
    minuteCandles: (mint) => read(mint, false),
    fiveMinuteCandles: (mint) => read(mint, true),
    takeStats() {
      const out = stats;
      stats = { pump: 0, gecko: 0, pumpRefused: 0 };
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
    let body: unknown;
    try {
      body = await gecko.poolMinuteCandles(pool, mint, nowMs, GECKO_WAIT_MS, aggregate);
    } catch (err) {
      if (err instanceof RateGateDeadlineError) {
        throw new HttpError(429, "geckoterminal", "GeckoTerminal budget spent (rate gate)");
      }
      throw err;
    }
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

async function readToken(mint: string): Promise<BackfillToken | null> {
  return prisma.token.findUnique({
    where: { mintAddress: mint },
    select: { launchpad: true, launchedAt: true, pairAddress: true },
  });
}
