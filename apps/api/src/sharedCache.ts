import { createLogger } from "@trenchscanner/core";

const logger = createLogger("shared-cache");

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

  constructor(private readonly ttlMs: number) {}

  /**
   * Returns the cached value, or produces one. `produce` runs at most once per TTL window no
   * matter how many callers arrive together.
   */
  async get(produce: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.value && this.value.expiresAt > now) return this.value.data;
    if (this.inFlight) return this.inFlight;

    this.inFlight = produce()
      .then((data) => {
        this.value = { data, expiresAt: Date.now() + this.ttlMs };
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
          this.inFlight = undefined;
          return data;
        },
        (err: unknown) => {
          this.inFlight = undefined;
          throw err;
        },
      );

    return this.inFlight;
  }

  /** Test seam: forget everything, as if the process had just started. */
  clear(): void {
    this.value = undefined;
  }
}
