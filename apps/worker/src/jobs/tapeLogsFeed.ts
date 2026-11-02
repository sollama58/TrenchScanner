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
 * budget (takeCredits), so following a coin never raises the tape's spend, only moves it. The live
 * tape (liveTape.ts) keeps a page it read current from these trades instead of reading it again,
 * and builds a page from them alone once they cover what a page would.
 *
 * The budget is also a ceiling here (audit 2026-11-02, DS-2). Paying the logs out of the page
 * budget only starved the pages: in its first hours the feed's 10 coins cost 370-580 credits a
 * minute against a 100-credit budget, because a busy curve's messages are mostly failed swaps
 * (~95%, each billed by Helius all the same) and nothing let a coin go for costing too much. So
 * follow() keeps the last minute's bytes per coin and, when they are over the ceiling the live
 * tape passes, lets the heaviest coins go first and holds them off for NOISY_HOLD_MS; while the
 * minute is at the ceiling no new coin is taken on. A coin let go falls back to Helius pages, as
 * every coin did before the feed, so no reading is lost, only its freshness.
 */

/** A followed coin is let go once the live tape hasn't asked about it for this long. */
export const IDLE_MS = 5 * 60_000;
/** Trades kept per coin, newest last: more than a page (100), so a page extended by them still covers 5 minutes. */
export const MAX_TRADES = 500;
/** The window the ceiling is measured over: the page budget is a per-minute figure too. */
export const CEILING_WINDOW_MS = 60_000;
/** A coin let go for its cost is not followed again for this long. */
export const NOISY_HOLD_MS = 10 * 60_000;
/** Helius bills 2 credits per 0.1 MB streamed (core's streamCredits), so a credit is this many bytes. */
const BYTES_PER_CREDIT = 100_000 / 2;
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
  /** This coin's billed messages in the last CEILING_WINDOW_MS, oldest first: [atMs, bytes]. */
  recent: [number, number][];
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
  /** Coins let go since the last call because their logs took the feed over its ceiling. */
  logsDropped: number;
};

export class TapeLogsFeed {
  private readonly followed = new Map<string, Followed>();
  /** Coins let go for their cost, and when: not followed again until NOISY_HOLD_MS has passed. */
  private readonly noisy = new Map<string, number>();
  private tradesRead = 0;
  private capped = 0;
  private dropped = 0;
  /** Bytes of this feed's logs not yet charged to the page budget (takeCredits). */
  private unchargedBytes = 0;
  /** Bytes since the last takeStats. */
  private statBytes = 0;

  constructor(
    private readonly stream: Stream,
    private readonly maxCoins: number,
  ) {}

  /**
   * Keeps following `mints` (and starts on new ones while there is room). `creditsPerMinute` is
   * the ceiling on what the followed coins' logs may cost over the last minute (the live tape's
   * page budget): over it, the heaviest coins are let go first, and none is taken on while the
   * minute is spent. Infinity, the default, never lets a coin go for its cost. Never throws.
   */
  follow(mints: readonly string[], now: number, creditsPerMinute = Number.POSITIVE_INFINITY): void {
    this.prune(now);
    const spent = this.enforceCeiling(creditsPerMinute * BYTES_PER_CREDIT, now);
    for (const mint of mints) {
      let f = this.followed.get(mint);
      if (!f) {
        if (this.followed.size >= this.maxCoins) {
          this.capped += 1;
          continue;
        }
        const heldAt = this.noisy.get(mint);
        if (heldAt !== undefined) {
          if (now - heldAt < NOISY_HOLD_MS) continue;
          this.noisy.delete(mint);
        }
        // The minute is spent: a new coin would only be let go again on the next call.
        if (spent >= creditsPerMinute * BYTES_PER_CREDIT) continue;
        const curve = pumpCurveAddressOf(mint);
        if (!curve) continue;
        f = {
          curve,
          pool: pumpSwapPoolOf(mint) ?? null,
          askedAt: now,
          trades: [],
          seen: new Set(),
          unpriced: false,
          recent: [],
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
  onLogs(
    key: string,
    signature: string,
    logs: readonly string[],
    bytes = 0,
    now: number = Date.now(),
  ): boolean {
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
    if (bytes > 0) f.recent.push([now, bytes]);
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
      logsDropped: this.dropped,
    };
    this.tradesRead = 0;
    this.capped = 0;
    this.dropped = 0;
    this.statBytes = 0;
    return out;
  }

  private prune(now: number): void {
    for (const [mint, f] of this.followed) {
      if (now - f.askedAt <= IDLE_MS) continue;
      this.letGo(mint, f);
    }
    for (const [mint, at] of this.noisy) if (now - at >= NOISY_HOLD_MS) this.noisy.delete(mint);
  }

  /**
   * Forgets messages older than the window, then lets coins go, heaviest first, until what the
   * rest cost in the last minute fits under `ceilingBytes`. Returns the bytes the coins still
   * followed cost in the window.
   */
  private enforceCeiling(ceilingBytes: number, now: number): number {
    const costs: [string, Followed, number][] = [];
    let total = 0;
    for (const [mint, f] of this.followed) {
      while (f.recent.length > 0 && now - f.recent[0]![0] > CEILING_WINDOW_MS) f.recent.shift();
      let bytes = 0;
      for (const [, b] of f.recent) bytes += b;
      costs.push([mint, f, bytes]);
      total += bytes;
    }
    if (total <= ceilingBytes) return total;
    costs.sort((a, b) => b[2] - a[2]);
    for (const [mint, f, bytes] of costs) {
      if (total <= ceilingBytes || bytes === 0) break;
      this.letGo(mint, f);
      this.noisy.set(mint, now);
      this.dropped += 1;
      total -= bytes;
      logger.info("tape logs: coin let go for its cost", {
        mint,
        credits: streamCredits(bytes),
        ceiling: streamCredits(ceilingBytes),
      });
    }
    return total;
  }

  private letGo(mint: string, f: Followed): void {
    this.followed.delete(mint);
    this.stream.unwatch(CURVE_KEY_PREFIX + mint);
    if (f.pool) this.stream.unwatch(POOL_KEY_PREFIX + mint);
  }
}
