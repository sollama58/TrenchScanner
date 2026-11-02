import {
  createLogger,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  streamCredits,
  tradesFromLogs,
  type HeliusAccountStream,
  type TapeTrade,
} from "@trenchscanner/core";

const logger = createLogger("tape-logs");

/**
 * The live tape's trades off the chain's logs (user decision 2026-11-02, "Helius logs, no
 * PumpPortal key"). PumpPortal streams trades only to a connection with a paid API key, so on
 * 2026-11-02 the scanner's tape took 0 pages from it and every coin's order flow came from 15
 * Helius pages a minute; in busy hours a third of decisions went without. Pump.fun's curve and
 * PumpSwap log every swap as an event carrying the trader and both sizes (core's
 * pumpTradeEvents.ts, which the token page's live trades already read), so a logsSubscribe on a
 * coin's curve and its pool delivers each trade as it lands, ~6 KB a trade and nothing between.
 *
 * Followed: the coins the live tape queues (contenders, then alerts held for a wallet figure), up
 * to `maxCoins`, on the scanner's existing Helius socket. A coin not asked about for IDLE_MS is
 * let go. Its bytes are billed like any stream's, and the live tape pays them out of its page
 * budget (takeCredits), so following a coin never raises the tape's spend, only moves it. The live tape (liveTape.ts) keeps a page it read current from these trades instead of
 * reading it again, and builds a page from them alone once they cover what a page would.
 */

/** A followed coin is let go once the live tape hasn't asked about it for this long. */
export const IDLE_MS = 5 * 60_000;
/** Trades kept per coin, newest last: more than a page (100), so a page extended by them still covers 5 minutes. */
export const MAX_TRADES = 500;
export const CURVE_KEY_PREFIX = "tape-curve:";
export const POOL_KEY_PREFIX = "tape-pool:";

type Stream = Pick<HeliusAccountStream, "watch" | "unwatch" | "coveredSince">;

interface Followed {
  curve: string;
  pool: string | null;
  askedAt: number;
  /** Oldest first. */
  trades: TapeTrade[];
  seen: Set<string>;
  /** A trade came that couldn't be priced in SOL (a coin-quoted curve): the feed can't vouch for this coin. */
  unpriced: boolean;
}

export type TapeLogsStats = {
  /** Coins followed now. */
  logsCoins: number;
  /** Of those, the ones whose curve (and pool) the socket covers now. */
  logsCovered: number;
  /** Trades read off the logs since the last call. */
  logsTrades: number;
  /** Coins turned away at maxCoins since the last call. */
  logsCapped: number;
  /** Helius credits the followed coins' logs cost since the last call (their bytes). */
  logsCredits: number;
};

export class TapeLogsFeed {
  private readonly followed = new Map<string, Followed>();
  private tradesRead = 0;
  private capped = 0;
  /** Bytes of this feed's logs not yet charged to the page budget (takeCredits). */
  private unchargedBytes = 0;
  /** Bytes since the last takeStats. */
  private statBytes = 0;

  constructor(
    private readonly stream: Stream,
    private readonly maxCoins: number,
  ) {}

  /** Keeps following `mints` (and starts on new ones while there is room). Never throws. */
  follow(mints: readonly string[], now: number): void {
    this.prune(now);
    for (const mint of mints) {
      let f = this.followed.get(mint);
      if (!f) {
        if (this.followed.size >= this.maxCoins) {
          this.capped += 1;
          continue;
        }
        const curve = pumpCurveAddressOf(mint);
        if (!curve) continue;
        f = {
          curve,
          pool: pumpSwapPoolOf(mint) ?? null,
          askedAt: now,
          trades: [],
          seen: new Set(),
          unpriced: false,
        };
        this.followed.set(mint, f);
      }
      f.askedAt = now;
      // Asked again every time, which keeps the stream's own unwatched-key eviction off them.
      this.stream.watch(CURVE_KEY_PREFIX + mint, [f.curve], now, "logs");
      if (f.pool) this.stream.watch(POOL_KEY_PREFIX + mint, [f.pool], now, "logs");
    }
  }

  /**
   * Since when every trade of `mint` has reached this feed (ms epoch), or null when it hasn't
   * been covered without a break: not followed, a subscription not confirmed yet or dropped by a
   * reconnect, or a trade it couldn't price.
   */
  coveredSince(mint: string, now: number): number | null {
    const f = this.followed.get(mint);
    if (!f || f.unpriced) return null;
    const curve = this.stream.coveredSince(CURVE_KEY_PREFIX + mint, f.curve, now);
    if (curve === null) return null;
    if (!f.pool) return curve;
    const pool = this.stream.coveredSince(POOL_KEY_PREFIX + mint, f.pool, now);
    return pool === null ? null : Math.max(curve, pool);
  }

  /** `mint`'s trades at or after `sinceMs`, oldest first. */
  tradesSince(mint: string, sinceMs: number): TapeTrade[] {
    const f = this.followed.get(mint);
    return f ? f.trades.filter((t) => t.atMs >= sinceMs) : [];
  }

  /**
   * One transaction's logs from the socket, for one of this feed's keys, `bytes` the message's size
   * as billed. Never throws.
   */
  onLogs(key: string, signature: string, logs: readonly string[], bytes = 0): boolean {
    const mint = key.startsWith(CURVE_KEY_PREFIX)
      ? key.slice(CURVE_KEY_PREFIX.length)
      : key.startsWith(POOL_KEY_PREFIX)
        ? key.slice(POOL_KEY_PREFIX.length)
        : null;
    if (mint === null) return false;
    // Billed whether or not the coin is still followed: a message after its unsubscribe costs too.
    this.unchargedBytes += bytes;
    this.statBytes += bytes;
    const f = this.followed.get(mint);
    if (!f) return true;
    try {
      for (const t of tradesFromLogs(logs, { mint, pool: f.pool })) {
        // The curve and the pool keys can both deliver one transaction.
        const id = `${signature}:${t.wallet}:${t.side}:${t.tokens}`;
        if (f.seen.has(id)) continue;
        f.seen.add(id);
        if (t.sol === null) {
          f.unpriced = true;
          continue;
        }
        this.tradesRead += 1;
        f.trades.push({
          wallet: t.wallet,
          side: t.side,
          sol: t.sol,
          tokens: t.tokens,
          atMs: t.atMs,
          tx: signature,
          ...(t.pool
            ? { mark: { quote: t.pool.quoteReserve, base: t.pool.baseReserve } }
            : t.priceSol !== null
              ? { mark: { curve: t.priceSol } }
              : {}),
        });
      }
      if (f.trades.length > MAX_TRADES) f.trades.splice(0, f.trades.length - MAX_TRADES);
      if (f.seen.size > MAX_TRADES * 4) f.seen = new Set([...f.seen].slice(-MAX_TRADES * 2));
    } catch (err) {
      logger.debug("tape logs not read", { mint, error: String(err) });
    }
    return true;
  }

  /** Helius credits this feed's logs cost since the last call: the live tape charges them to its page budget. */
  takeCredits(): number {
    const credits = (this.unchargedBytes / 100_000) * 2;
    this.unchargedBytes = 0;
    return credits;
  }

  /** The counts since the last call, for the scan's heartbeat. */
  takeStats(now: number = Date.now()): TapeLogsStats {
    let covered = 0;
    for (const mint of this.followed.keys()) if (this.coveredSince(mint, now) !== null) covered += 1;
    const out = {
      logsCoins: this.followed.size,
      logsCovered: covered,
      logsTrades: this.tradesRead,
      logsCapped: this.capped,
      logsCredits: streamCredits(this.statBytes),
    };
    this.tradesRead = 0;
    this.capped = 0;
    this.statBytes = 0;
    return out;
  }

  private prune(now: number): void {
    for (const [mint, f] of this.followed) {
      if (now - f.askedAt <= IDLE_MS) continue;
      this.followed.delete(mint);
      this.stream.unwatch(CURVE_KEY_PREFIX + mint);
      if (f.pool) this.stream.unwatch(POOL_KEY_PREFIX + mint);
    }
  }
}
