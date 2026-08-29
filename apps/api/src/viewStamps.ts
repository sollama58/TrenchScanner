import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("view-stamps");

/** How long stamps accumulate before one batched write. */
const FLUSH_INTERVAL_MS = 5_000;

/**
 * Flush early if this many distinct tokens pile up before the interval. A ceiling on memory and
 * on the size of any single UPDATE, not a tuning knob - the interval is what normally fires.
 */
const MAX_PENDING = 2_000;

/**
 * Coalesces Token.lastViewedAt stamps and writes them in the background.
 *
 * Every feed page load used to run its own BEGIN / UPDATE / COMMIT before it could reply - three
 * of the nine database round-trips a page cost, on the critical path of a request whose job is to
 * return rows it had already fetched.
 *
 * Worse than the round-trips was the contention. The curated feed is the same twelve alerts for
 * every subscriber, so every concurrent reader was updating the *same twelve rows*, and Postgres
 * serialises writers to a row. Measured at 300 concurrent stamps: 790ms when they all target the
 * same twelve rows against 172ms across distinct ones - a 4.6x penalty that grows with readership,
 * which is the wrong direction for a number that is only ever read by a once-a-minute job.
 *
 * Buffering turns N concurrent updates of the same row into one update per flush. The request path
 * keeps nothing but a Set insert.
 *
 * This is safe because of what the stamp is for: ACTIVE_VIEW_WINDOW_MINUTES is 10 minutes and the
 * worker reads the column once a minute, so a stamp landing five seconds late is invisible. The
 * column was already documented as lossy-tolerant - see Token.lastViewedAt - and a dropped stamp
 * costs at most one skipped live-price refresh, which the reader's next poll re-requests anyway.
 */
export class ViewStampBuffer {
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  /** Guards against a slow write overlapping the next tick and stacking flushes. */
  private flushing = false;
  private stopped = false;

  constructor(private readonly options: { flushIntervalMs?: number; maxPending?: number } = {}) {}

  /** Non-blocking. Records that these tokens are on a page somebody just fetched. */
  record(tokenIds: readonly string[]): void {
    if (this.stopped) return;
    for (const id of tokenIds) this.pending.add(id);

    if (this.pending.size >= (this.options.maxPending ?? MAX_PENDING)) {
      void this.flush();
      return;
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushIntervalMs ?? FLUSH_INTERVAL_MS);
    // Never hold the process open for a stamp - see stop() for the shutdown path.
    this.timer.unref?.();
  }

  /**
   * Writes everything buffered so far. Failures are logged and the batch is dropped rather than
   * retried: re-queueing across an outage would grow without bound, and the next page view
   * re-stamps every token that is still being looked at.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;

    // Swapped before the await so stamps arriving mid-write land in the next batch instead of
    // being cleared unwritten.
    const batch = [...this.pending];
    this.pending.clear();

    try {
      await prisma.token.updateMany({
        where: { id: { in: batch } },
        data: { lastViewedAt: new Date() },
      });
    } catch (err) {
      logger.error("could not flush view stamps", { err: String(err), count: batch.length });
    } finally {
      this.flushing = false;
      this.arm();
    }
  }

  /** Final flush for shutdown, so the last page anyone opened is not lost. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
