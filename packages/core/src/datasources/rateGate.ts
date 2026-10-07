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
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RateGateOptions) {
    this.msPerToken = 60_000 / Math.max(1, options.perMinute);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = Math.max(1, options.burst);
    this.refilledAt = this.now();
  }

  /**
   * Waits for a slot and takes it. Throws RateGateDeadlineError, without waiting, once the slot
   * would open only after `deadline` (an epoch ms).
   */
  async acquire(deadline = Infinity): Promise<void> {
    const startedAt = this.now();
    for (;;) {
      const now = this.now();
      this.refill(now);
      const wait = Math.max(
        this.pausedUntil - now,
        this.tokens >= 1 ? 0 : (1 - this.tokens) * this.msPerToken,
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
