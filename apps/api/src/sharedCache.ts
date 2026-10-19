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
   * waits for a fresh fill, so an idle cache doesn't answer with something arbitrarily old while
   * the database is fine. If that fill fails, though, the reader still gets the last good value,
   * however old (see fill()): during an outage a dated answer beats an error page, on purpose.
   * Only a cache that never filled propagates the error. Zero (the default) keeps the
   * strict behaviour, which is what the feed pages need: they are cleared the moment a new alert
   * lands and must never answer with the pre-alert rows.
   */
  staleWhileRevalidateMs?: number;
  /**
   * Names the cache in GET /stats/caches (cacheReport below), which reports each named cache's
   * TTL, age and how long its fills take. Unnamed caches (the per-user feed pages) are left out.
   */
  name?: string;
  /**
   * The oldest value a failed fill may still answer with (see fill()). Unset, any age: a dated
   * feed beats an error page. The admin reports set it, since an admin reading a report hours old
   * as current (the database down, every fill failing) is worse off than one seeing the error.
   */
  maxStaleOnErrorMs?: number;
}

/** maxStaleOnErrorMs for the admin panel's reports: a few of their fills, then the error. */
export const ADMIN_STALE_ON_ERROR_MS = 15 * 60_000;

/** What GET /stats/caches reports for one named cache. */
export interface CacheReportRow {
  name: string;
  ttlSeconds: number;
  staleWhileRevalidateSeconds: number;
  /** How old the value being served is, in seconds; null before the first fill. */
  ageSeconds: number | null;
  filling: boolean;
  fills: number;
  failedFills: number;
  lastFillMs: number | null;
  maxFillMs: number | null;
  meanFillMs: number | null;
  /** Readers who had to wait on a fill (cold cache, or past the stale window). */
  waitedOnFill: number;
  /** Readers answered with an expired value while it refilled behind them. */
  servedStale: number;
}

/** Every named cache in this process, for cacheReport(). Caches are created once per key and live as long as the process. */
const named = new Set<SharedCache<unknown>>();

/** The named caches, slowest fill first: the order someone hunting for a slow page wants. */
export function cacheReport(): CacheReportRow[] {
  return [...named]
    .map((c) => c.report())
    .sort((a, b) => (b.maxFillMs ?? 0) - (a.maxFillMs ?? 0) || a.name.localeCompare(b.name));
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
  private readonly maxStaleOnErrorMs: number | undefined;
  private readonly name: string | undefined;
  private readonly stats = { fills: 0, failed: 0, lastMs: 0, maxMs: 0, totalMs: 0, waited: 0, stale: 0 };
  private filledAt = 0;

  constructor(
    private readonly ttlMs: number,
    opts: SharedCacheOptions = {},
  ) {
    this.staleMs = opts.staleWhileRevalidateMs ?? 0;
    this.maxStaleOnErrorMs = opts.maxStaleOnErrorMs;
    this.name = opts.name;
    if (this.name) named.add(this as SharedCache<unknown>);
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
      this.stats.stale += 1;
      return this.value.data;
    }
    this.stats.waited += 1;
    if (this.inFlight) return this.inFlight;
    return this.fill(produce);
  }

  /**
   * Starts a fill now if the cache has nothing fresh and none is running - used to warm a cache at
   * startup so the first reader after a deploy doesn't pay for it, or to refill one before a
   * reader finds it expired. Resolves when that fill settles (at once when none was needed), so a
   * caller can run several one after another. Never rejects.
   *
   * `aheadMs` refills a value that is still fresh but expires within that long: a keeper that
   * checks every minute passes a little over a minute, so the value is replaced before it ever
   * expires and no reader is the one to notice it has.
   */
  warm(produce: () => Promise<T>, aheadMs = 0): Promise<void> {
    if (this.value && this.value.expiresAt - aheadMs > Date.now()) return Promise.resolve();
    if (this.inFlight) return Promise.resolve();
    return this.fill(produce).then(
      () => undefined,
      (err: unknown) => logger.warn("warm-up failed", { err: String(err) }),
    );
  }

  private fill(produce: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const started = performance.now();
    const fill: Promise<T> = produce()
      .then((data) => {
        const ms = performance.now() - started;
        this.stats.fills += 1;
        this.stats.lastMs = ms;
        this.stats.maxMs = Math.max(this.stats.maxMs, ms);
        this.stats.totalMs += ms;
        if (generation === this.generation) {
          this.value = { data, expiresAt: Date.now() + this.ttlMs };
          this.filledAt = Date.now();
        }
        return data;
      })
      .catch((err: unknown) => {
        this.stats.failed += 1;
        // Serve a stale value over failing the page: a feed a few seconds old is a better answer
        // than an error, and the next request retries. Only a cold cache propagates the error.
        if (
          this.value &&
          (this.maxStaleOnErrorMs === undefined || Date.now() - this.filledAt <= this.maxStaleOnErrorMs)
        ) {
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

  report(): CacheReportRow {
    const s = this.stats;
    const ms = (n: number) => Math.round(n);
    return {
      name: this.name ?? "(unnamed)",
      ttlSeconds: Math.round(this.ttlMs / 1000),
      staleWhileRevalidateSeconds: Math.round(this.staleMs / 1000),
      ageSeconds: this.value ? Math.round((Date.now() - this.filledAt) / 1000) : null,
      filling: this.inFlight !== undefined,
      fills: s.fills,
      failedFills: s.failed,
      lastFillMs: s.fills > 0 ? ms(s.lastMs) : null,
      maxFillMs: s.fills > 0 ? ms(s.maxMs) : null,
      meanFillMs: s.fills > 0 ? ms(s.totalMs / s.fills) : null,
      waitedOnFill: s.waited,
      servedStale: s.stale,
    };
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

/**
 * A bounded family of SharedCaches, one per key - for answers that are the same for every
 * reader of the same key (one user's feed stats, say) rather than for everyone.
 *
 * Bounded because the keys come from requests: left unbounded, a map keyed by user and window
 * is a slow leak driven by whoever asks. Past `maxEntries` the least recently used key goes;
 * losing one costs that reader a single refill. Each entry's TTL is `ttlMs`, strict by default
 * (the feed caches, cleared the moment a new alert lands); a list nothing clears by hand, such as
 * the Stream's pages, can pass a stale-while-revalidate window.
 */
export class SharedCacheMap<T> {
  private readonly caches = new Map<string, SharedCache<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    /** Each key's cache's stale-while-revalidate window (SharedCacheOptions); unnamed. */
    private readonly staleWhileRevalidateMs = 0,
    /** Each key's cache's maxStaleOnErrorMs (SharedCacheOptions). */
    private readonly maxStaleOnErrorMs?: number,
  ) {}

  /** The cache for `key`, created on first use. Marks it most recently used. */
  for(key: string): SharedCache<T> {
    const existing = this.caches.get(key);
    if (existing) {
      // Map iteration is insertion order, so re-inserting is what makes eviction below LRU.
      this.caches.delete(key);
      this.caches.set(key, existing);
      return existing;
    }
    const cache = new SharedCache<T>(this.ttlMs, {
      staleWhileRevalidateMs: this.staleWhileRevalidateMs,
      maxStaleOnErrorMs: this.maxStaleOnErrorMs,
    });
    this.caches.set(key, cache);
    if (this.caches.size > this.maxEntries) {
      const oldest = this.caches.keys().next().value;
      if (oldest !== undefined) this.caches.delete(oldest);
    }
    return cache;
  }

  /** Forgets every value whose key starts with `keyPrefix` (all of them by default). */
  clear(keyPrefix = ""): void {
    this.clearWhere((key) => key.startsWith(keyPrefix));
  }

  /** Forgets every value whose key passes `test`. */
  clearWhere(test: (key: string) => boolean): void {
    for (const [key, cache] of this.caches) if (test(key)) cache.clear();
  }

  /** Test seam: how many keys are held. */
  get size(): number {
    return this.caches.size;
  }
}
