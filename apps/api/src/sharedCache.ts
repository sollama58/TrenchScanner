import { createLogger } from "@trenchscanner/core";

const logger = createLogger("shared-cache");

export interface SharedCacheOptions {
  /**
   * Stale-while-revalidate: for this long past the TTL, a reader gets the expired value at once
   * and the refresh runs behind them, instead of that reader waiting out the whole fill.
   *
   * Meant for the heavy report caches (learning panel, Model tab, leaderboards), whose fills are
   * dozens of aggregates and take most of a second in production: without it, whoever happened
   * to arrive first after each expiry paid that second on their page load, every few minutes,
   * for figures that move hourly. Past this window the cache is treated as cold and the reader
   * waits, so an idle cache never serves something arbitrarily old. Zero (the default) keeps the
   * strict behaviour, which is what the feed pages need: they are cleared the moment a new alert
   * lands and must never answer with the pre-alert rows.
   */
  staleWhileRevalidateMs?: number;
}

/**
 * A tiny single-flight TTL cache for values that are the same for every reader.
 *
 * The curated feed is the motivating case: it is one list of alerts shown identically to every
 * subscriber, but each request re-ran the query, so cost scaled with readership even though the
 * answer did not.
 *
 * Single-flight is the part that matters at this concurrency, and is why this is not three lines
 * around a Map. A plain TTL cache leaves a stampede at every expiry: the entry lapses, the next N
 * concurrent requests all miss, and all N run the same query at once - the load spike lands
 * exactly when the system is busiest, because that is when N is largest. Storing the in-flight
 * promise rather than only the settled value means the first request through does the work and
 * everyone else waits on that same promise.
 *
 * Deliberately per-process and unbounded in staleness terms: entries live for `ttlMs` and are
 * replaced, never invalidated by hand. Two API instances can therefore serve answers up to
 * `ttlMs` apart, which is fine for a feed that is already a poll behind, and much cheaper than
 * coordinating.
 */
export class SharedCache<T> {
  private value: { data: T; expiresAt: number } | undefined;
  private inFlight: Promise<T> | undefined;
  /** Bumped by clear(): a fill that started before the bump must not store its (older) result. */
  private generation = 0;
  private readonly staleMs: number;

  constructor(
    private readonly ttlMs: number,
    opts: SharedCacheOptions = {},
  ) {
    this.staleMs = opts.staleWhileRevalidateMs ?? 0;
  }

  /**
   * Returns the cached value, or produces one. `produce` runs at most once per TTL window no
   * matter how many callers arrive together.
   */
  async get(produce: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.value && this.value.expiresAt > now) return this.value.data;
    if (this.value && this.staleMs > 0 && this.value.expiresAt + this.staleMs > now) {
      // Stale but usable: answer now, refresh once in the background. A failed refresh already
      // falls back to this same value inside fill(), so nothing here can reject.
      if (!this.inFlight) void this.fill(produce).catch(() => {});
      return this.value.data;
    }
    if (this.inFlight) return this.inFlight;
    return this.fill(produce);
  }

  /**
   * Starts a fill now if the cache has nothing fresh and none is running - used to warm a cache at
   * startup so the first reader after a deploy doesn't pay for it. Never rejects.
   */
  warm(produce: () => Promise<T>): void {
    if (this.value && this.value.expiresAt > Date.now()) return;
    if (this.inFlight) return;
    void this.fill(produce).catch((err: unknown) => logger.warn("warm-up failed", { err: String(err) }));
  }

  private fill(produce: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const fill: Promise<T> = produce()
      .then((data) => {
        if (generation === this.generation) this.value = { data, expiresAt: Date.now() + this.ttlMs };
        return data;
      })
      .catch((err: unknown) => {
        // Serve a stale value over failing the page: a feed a few seconds old is a better answer
        // than an error, and the next request retries. Only a cold cache propagates the error.
        if (this.value) {
          logger.warn("refresh failed, serving stale", { err: String(err) });
          return this.value.data;
        }
        throw err;
      })
      // finally() returns a NEW promise that rejects when the original does, so attaching the
      // cleanup with then(fn, fn) is what keeps a rejected produce() from surfacing as an
      // unhandled rejection here.
      .then(
        (data) => {
          if (this.inFlight === fill) this.inFlight = undefined;
          return data;
        },
        (err: unknown) => {
          if (this.inFlight === fill) this.inFlight = undefined;
          throw err;
        },
      );
    this.inFlight = fill;
    return fill;
  }

  /** Test seam: forget everything, as if the process had just started. */
  clear(): void {
    this.value = undefined;
    // Also forget a fill already in flight: it read the database before whatever prompted this
    // clear, so storing it - or handing it to readers who arrive now - would serve the old rows
    // for a full TTL. That is exactly the case clear() exists for (a new curated alert's NOTIFY).
    this.generation += 1;
    this.inFlight = undefined;
  }
}
