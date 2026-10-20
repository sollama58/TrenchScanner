import { createLogger } from "../logger.js";

const logger = createLogger("rate-gate");

/** Thrown by RateGate.acquire when no slot opens before the caller's deadline. */
export class RateGateDeadlineError extends Error {
  constructor() {
    super("no request slot before the deadline");
    this.name = "RateGateDeadlineError";
  }
}

export interface RateGateStats {
  /** Requests let through since the last takeStats(). */
  requests: number;
  /** Times the provider answered 429 and every request was paused. */
  throttled: number;
  /** Total time requests spent waiting for a slot, in ms. */
  waitedMs: number;
  /** Requests that gave up waiting because their caller's deadline would pass first. */
  gaveUp: number;
}

export interface RateGateOptions {
  /** Sustained requests a minute. */
  perMinute: number;
  /** Requests that may go out back to back before the sustained rate applies. */
  burst: number;
  /**
   * Of the burst, the slots only a priority request may take (see acquire): an ordinary request
   * waits while the bucket holds this many or fewer. 0 (the default) makes every request equal.
   */
  reserve?: number;
  /**
   * Shortest pause a 429 sets. Without a Retry-After header the pause was fetchJson's first
   * backoff, 250-750 ms, and the queued requests went straight back into the provider's window
   * (DexScreener's and Jupiter's limits are per second or per minute).
   */
  minPauseMs?: number;
  /** Name used in the log line a throttle writes. */
  name: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One process's budget for one provider: a token bucket every request waits on, and a shared
 * pause when the provider answers 429.
 *
 * Without it, each job fanned out its own batches (five at a time, several jobs a minute), so the
 * provider saw bursts well past its per-minute limit whenever jobs overlapped. And a 429 only held
 * back the request that got it: the other batches in flight kept firing into the same limit, each
 * logging its own retry (2026-10-07).
 */
export class RateGate {
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private stats: RateGateStats = { requests: 0, throttled: 0, waitedMs: 0, gaveUp: 0 };
  private readonly msPerToken: number;
  private readonly reserve: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RateGateOptions) {
    this.msPerToken = 60_000 / Math.max(1, options.perMinute);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = Math.max(1, options.burst);
    // Never the whole burst: an ordinary request must still be able to go out on a full bucket.
    this.reserve = Math.min(Math.max(0, options.reserve ?? 0), Math.max(1, options.burst) - 1);
    this.refilledAt = this.now();
  }

  /**
   * Waits for a slot and takes it. Throws RateGateDeadlineError, without waiting, once the slot
   * would open only after `deadline` (an epoch ms).
   *
   * A `priority` request may take the reserved slots too. The scan's band refresh and its fresh
   * quotes are what a decision waits on; background jobs sharing the budget (the outcome watcher,
   * live prices) used to drain the bucket just before a cycle, and the refresh then queued at the
   * sustained rate - 8-10 s of a cycle on about one in six cycles (worker health, 2026-10-13).
   * With a reserve the background jobs leave that many slots, so a cycle's lookups go out at once.
   */
  async acquire(deadline = Infinity, priority = false): Promise<void> {
    const startedAt = this.now();
    const needed = 1 + (priority ? 0 : this.reserve);
    for (;;) {
      const now = this.now();
      this.refill(now);
      const wait = Math.max(
        this.pausedUntil - now,
        this.tokens >= needed ? 0 : (needed - this.tokens) * this.msPerToken,
      );
      if (wait <= 0) {
        this.tokens -= 1;
        this.stats.requests += 1;
        this.stats.waitedMs += now - startedAt;
        return;
      }
      if (now + wait > deadline) {
        this.stats.gaveUp += 1;
        throw new RateGateDeadlineError();
      }
      await this.sleep(Math.ceil(wait));
    }
  }

  /**
   * The provider answered 429: hold every request for `delayMs`, then start again from an empty
   * bucket so the requests that queued up meanwhile don't all go out at once.
   */
  throttled(delayMs: number): void {
    const now = this.now();
    delayMs = Math.max(delayMs, this.options.minPauseMs ?? 0);
    const until = now + Math.max(0, delayMs);
    if (now >= this.pausedUntil) {
      this.stats.throttled += 1;
      logger.warn("provider rate-limited us - pausing every request to it", {
        provider: this.options.name,
        delayMs,
      });
    }
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.tokens = 0;
      this.refilledAt = until;
    }
  }

  /** Counts since the last call, then reset. */
  takeStats(): RateGateStats {
    const stats = { ...this.stats, waitedMs: Math.round(this.stats.waitedMs) };
    this.stats = { requests: 0, throttled: 0, waitedMs: 0, gaveUp: 0 };
    return stats;
  }

  private refill(now: number): void {
    if (now <= this.refilledAt) return;
    this.tokens = Math.min(
      Math.max(1, this.options.burst),
      this.tokens + (now - this.refilledAt) / this.msPerToken,
    );
    this.refilledAt = now;
  }
}
