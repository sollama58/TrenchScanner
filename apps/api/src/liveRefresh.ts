import { createLogger, refreshLiveMarketData, type DexScreenerClient } from "@trenchscanner/core";

const logger = createLogger("live-refresh");

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
   * this deployment ever promises to be, so refreshing it would buy nothing.
   */
  maxAgeMs: number;
  /** Hard cap on tokens per refresh - one page's worth, i.e. one batched DexScreener call. */
  limit: number;
}

/**
 * Refreshes market data for the tokens on a page the moment that page is fetched.
 *
 * Why this exists on top of the worker's periodic live-price job: that job only knows a token is
 * being looked at *after* GET /matches has stamped Token.lastViewedAt, and it only ticks once a
 * minute. So the first load of any page - including paging back to one visited earlier - showed
 * whatever the last scan or live tick left behind, for up to a full minute. Kicking a refresh off
 * from the request itself closes that gap; the dashboard polls, so the fresh numbers land on the
 * next poll a few seconds later.
 *
 * Three things keep this from turning every poll into an upstream call:
 *
 *  - Freshness. A token whose reading is younger than maxAgeMs is skipped outright, so the steady
 *    poll of a page that's already current costs nothing.
 *  - In-flight de-duplication. Concurrent requests for the same token (several users on the same
 *    page, or one user's poll overlapping the previous one) collapse into a single lookup.
 *  - A cooldown on *attempts*, not successes. This is the one that matters: a token DexScreener
 *    has no data for never gets liveDataAt written, so it would look stale forever and be retried
 *    on every single request. Recording the attempt is what stops that.
 *
 * The upshot is that upstream cost is bounded by how many distinct tokens are being viewed per
 * cooldown window, not by how many people are viewing them - the same bound the worker's job has.
 */
export class OnDemandLiveRefresher {
  private readonly inFlight = new Set<string>();
  private readonly attemptedAt = new Map<string, number>();

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

  /** Awaitable form of {@link request}. Returns how many tokens it actually looked up. */
  async refresh(tokens: readonly RefreshableToken[], now = Date.now()): Promise<number> {
    const due = this.selectDue(tokens, now);
    if (due.length === 0) return 0;

    for (const token of due) {
      this.inFlight.add(token.mintAddress);
      this.attemptedAt.set(token.mintAddress, now);
    }
    try {
      const result = await refreshLiveMarketData(this.dexScreener, due);
      logger.info("on-demand live refresh", { requested: result.requested, updated: result.updated });
      return result.requested;
    } finally {
      for (const token of due) this.inFlight.delete(token.mintAddress);
    }
  }

  /** Which of these tokens are stale, not already being fetched, and off cooldown. Exposed for tests. */
  selectDue(tokens: readonly RefreshableToken[], now: number): RefreshableToken[] {
    this.pruneAttempts(now);
    const due: RefreshableToken[] = [];
    const claimed = new Set<string>();

    for (const token of tokens) {
      if (due.length >= this.options.limit) break;
      // One page can legitimately hold several matches on the same token; only fetch it once.
      if (claimed.has(token.mintAddress)) continue;
      if (this.inFlight.has(token.mintAddress)) continue;
      const attempted = this.attemptedAt.get(token.mintAddress);
      if (attempted !== undefined && now - attempted < this.options.maxAgeMs) continue;
      const age = token.liveDataAt ? now - token.liveDataAt.getTime() : Infinity;
      if (age < this.options.maxAgeMs) continue;

      claimed.add(token.mintAddress);
      due.push(token);
    }
    return due;
  }

  /** Keeps the cooldown map from growing with every token this process has ever seen. */
  private pruneAttempts(now: number): void {
    for (const [mint, at] of this.attemptedAt) {
      if (now - at >= this.options.maxAgeMs) this.attemptedAt.delete(mint);
    }
  }
}
