import { createLogger, refreshLiveMarketData, type DexScreenerClient } from "@trenchscanner/core";

const logger = createLogger("live-refresh");

/** DexScreener's batch lookup takes 30 addresses per call - see DexScreenerClient. */
const ADDRESSES_PER_CALL = 30;
const BUDGET_WINDOW_MS = 60_000;
const MAX_DURATIONS = 200;

/** The shape GET /matches already has to hand for every token on the page. */
export interface RefreshableToken {
  id: string;
  mintAddress: string;
  liveDataAt: Date | null;
}

export interface OnDemandLiveRefresherOptions {
  /**
   * How old a token's live reading may be before opening a page is worth a fresh lookup for it.
   * Set to the worker's live-price cadence: anything fresher than that is already as current as
   * the worker keeps it, so a page load refreshing it would buy nothing. The live tick
   * (GET /live/market) asks for a tighter bound per call; this is also the ceiling on that.
   */
  maxAgeMs: number;
  /** Hard cap on tokens per refresh - one page's worth, i.e. one batched DexScreener call. */
  limit: number;
  /**
   * Upstream calls this process may make per minute, across every reader. DexScreener allows
   * 300 a minute on the batch endpoint; the worker spends some of that from its own host. Past
   * the budget a refresh is skipped and readers get the worker's once-a-minute numbers, which is
   * slower, never broken.
   */
  callsPerMinute?: number;
  /** Where the refreshed tokens' matches get their peak raised - see refreshLiveMarketData. */
  peakWindowDays?: number;
}

/**
 * Refreshes market data for the tokens on screen, on request.
 *
 * Two callers. A page load (GET /matches, GET /curated) fires one off without waiting, at the
 * worker's cadence, so a page opened between worker ticks doesn't sit on old numbers. The live
 * tick (GET /live/market), which an open dashboard polls every few seconds, waits for one at a
 * much tighter bound so the numbers it returns are seconds old rather than up to a minute.
 *
 * Four things keep this from turning every poll into an upstream call:
 *
 *  - Freshness. A token whose reading is younger than the bound is skipped outright.
 *  - In-flight sharing. Concurrent requests for the same token (several users on the same page,
 *    a page load and a tick together) share one lookup, and a waiting caller waits on it.
 *  - A cooldown on *attempts*, not successes. A token DexScreener has no data for never gets
 *    liveDataAt written, so it would look stale forever and be retried on every request.
 *  - A per-minute call budget, so the number of readers can't push the API over DexScreener's
 *    rate limit.
 *
 * One instance per process (server.ts), shared by every route, so all of the above hold across
 * routes rather than per route.
 */
export class OnDemandLiveRefresher {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly attemptedAt = new Map<string, number>();
  private readonly calls: number[] = [];
  private readonly counters = { lookups: 0, tokens: 0, failures: 0, overBudget: 0, since: new Date() };
  /** The latest lookups' durations (ms), newest last - for /stats/live. */
  private readonly durations: number[] = [];

  constructor(
    private readonly dexScreener: DexScreenerClient,
    private readonly options: OnDemandLiveRefresherOptions,
  ) {}

  /**
   * Fire-and-forget: never awaited by the request handler, so a slow DexScreener can't slow down
   * (or fail) the page load that triggered it.
   */
  request(tokens: readonly RefreshableToken[]): void {
    void this.refresh(tokens).catch((err) => {
      logger.warn("on-demand live refresh failed", { error: String(err) });
    });
  }

  /**
   * Refreshes whatever of `tokens` is older than `maxAgeMs` and waits - at most `timeoutMs` - for
   * that and for any lookup already in flight for these tokens. Resolves true when anything was
   * looked up or waited on, i.e. when re-reading the rows can find newer numbers. Never throws.
   */
  async refreshAndWait(
    tokens: readonly RefreshableToken[],
    { maxAgeMs, timeoutMs }: { maxAgeMs: number; timeoutMs: number },
  ): Promise<boolean> {
    const pending = new Set<Promise<unknown>>();
    for (const token of tokens) {
      const running = this.inFlight.get(token.mintAddress);
      if (running) pending.add(running);
    }
    const own = this.start(tokens, Date.now(), maxAgeMs);
    if (own) pending.add(own);
    if (pending.size === 0) return false;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled(pending), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /** Awaitable form of {@link request}. Returns how many tokens it actually looked up. */
  async refresh(tokens: readonly RefreshableToken[], now = Date.now(), maxAgeMs?: number): Promise<number> {
    return (await this.start(tokens, now, maxAgeMs)) ?? 0;
  }

  /**
   * Picks what is due and starts one lookup for it, synchronously, so a caller knows at once
   * whether there is anything to wait for. Null when nothing is due or the budget is spent.
   */
  private start(tokens: readonly RefreshableToken[], now: number, maxAgeMs?: number): Promise<number> | null {
    const due = this.selectDue(tokens, now, maxAgeMs);
    if (due.length === 0) return null;
    if (!this.takeBudget(Math.ceil(due.length / ADDRESSES_PER_CALL), now)) return null;

    for (const token of due) this.attemptedAt.set(token.mintAddress, now);
    const lookup = refreshLiveMarketData(this.dexScreener, due, {
      peakWindowDays: this.options.peakWindowDays,
    })
      .then((result) => {
        logger.debug("on-demand live refresh", { requested: result.requested, updated: result.updated });
        return result.requested;
      })
      .finally(() => {
        for (const token of due) {
          if (this.inFlight.get(token.mintAddress) === lookup) this.inFlight.delete(token.mintAddress);
        }
      });
    for (const token of due) this.inFlight.set(token.mintAddress, lookup);
    return lookup;
  }

  /**
   * Which of these tokens are older than `maxAgeMs` (default: the configured bound, and never
   * looser than it), not already being fetched, and off cooldown. Exposed for tests.
   */
  selectDue(tokens: readonly RefreshableToken[], now: number, maxAgeMs?: number): RefreshableToken[] {
    const bound = Math.min(maxAgeMs ?? this.options.maxAgeMs, this.options.maxAgeMs);
    this.pruneAttempts(now);
    const due: RefreshableToken[] = [];
    const claimed = new Set<string>();

    for (const token of tokens) {
      if (due.length >= this.options.limit) break;
      // One page can legitimately hold several matches on the same token; only fetch it once.
      if (claimed.has(token.mintAddress)) continue;
      if (this.inFlight.has(token.mintAddress)) continue;
      const attempted = this.attemptedAt.get(token.mintAddress);
      if (attempted !== undefined && now - attempted < bound) continue;
      const age = token.liveDataAt ? now - token.liveDataAt.getTime() : Infinity;
      if (age < bound) continue;

      claimed.add(token.mintAddress);
      due.push(token);
    }
    return due;
  }

  /** Records `count` upstream calls if the last minute's budget has room for them. */
  private takeBudget(count: number, now: number): boolean {
    const budget = this.options.callsPerMinute;
    if (budget === undefined) return true;
    while (this.calls.length > 0 && now - this.calls[0]! >= BUDGET_WINDOW_MS) this.calls.shift();
    if (this.calls.length + count > budget) {
      this.counters.overBudget += 1;
      logger.debug("live refresh over its call budget, skipping", { budget });
      return false;
    }
    for (let i = 0; i < count; i += 1) this.calls.push(now);
    return true;
  }

  /** What this process's refresher has done since it started - served on /stats/live. */
  stats() {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null;
    return {
      ...this.counters,
      callsLastMinute: this.calls.filter((t) => Date.now() - t < BUDGET_WINDOW_MS).length,
      callsPerMinuteBudget: this.options.callsPerMinute ?? null,
      lookupMs: { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null, sample: sorted.length },
    };
  }

  /** Keeps the cooldown map from growing with every token this process has ever seen. */
  private pruneAttempts(now: number): void {
    for (const [mint, at] of this.attemptedAt) {
      if (now - at >= this.options.maxAgeMs) this.attemptedAt.delete(mint);
    }
  }
}
