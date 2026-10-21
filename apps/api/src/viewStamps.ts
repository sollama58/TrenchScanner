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
  /** Id to the poll time it was recorded at. A holders flush writes later than this. */
  private pending = new Map<string, number>();
  /**
   * For a holders stamp, the poll a flush wrote and the timestamp that flush stored. The release
   * compares against this, not the poll: the column is the flush time, a few seconds later.
   */
  private writtenHolderStamp = new Map<string, { pollAt: number; writtenAt: number }>();
  private timer: NodeJS.Timeout | undefined;
  /** Guards against a slow write overlapping the next tick and stacking flushes. */
  private flushing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly options: {
      flushIntervalMs?: number;
      maxPending?: number;
      /**
       * Which stamp: "viewed" (Token.lastViewedAt, by token id; the default) or "holders"
       * (Token.holdersViewedAt, by mint: the coin's bubble map is open, user ask 2026-10-19).
       */
      stamp?: "viewed" | "holders";
    } = {},
  ) {}

  /**
   * Drops ids from the pending stamp set. A bubble map that just slid out of an account's four
   * must not be rewritten by a flush of the poll that is releasing it (user ask 2026-10-21).
   */
  dismiss(ids: readonly string[]): void {
    for (const id of ids) this.pending.delete(id);
  }

  /**
   * Non-blocking. Records that these tokens are on a page somebody just fetched: token ids, or
   * mints for the "holders" stamp. `at` is the poll time for a holders stamp; the flush writes
   * that poll's stamp a few seconds later, and a release clears by the time that was written.
   */
  record(tokenIds: readonly string[], at = Date.now()): void {
    if (this.stopped) return;
    for (const id of tokenIds) this.pending.set(id, at);

    if (this.pending.size >= (this.options.maxPending ?? MAX_PENDING)) {
      void this.flush();
      return;
    }
    this.arm();
  }

  private arm(): void {
    if (this.stopped || this.timer || this.pending.size === 0) return;
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
    this.flushing = this.write().finally(() => {
      this.flushing = null;
      this.arm();
    });
    await this.flushing;
  }

  /**
   * Waits out a flush already in flight. A release that starts while its poll is being written
   * has to clear the timestamp that write stores, which is not known until the batch is swapped.
   */
  async settle(): Promise<void> {
    if (this.flushing) await this.flushing;
  }

  /**
   * The time a released holders poll should clear through. A flush stores `new Date()` at write
   * time, which is after the poll, so a clear bounded by the poll never matches that row.
   */
  holderStampClearAt(mint: string, pollAt: number): number {
    return holderStampClearAt(pollAt, this.writtenHolderStamp.get(mint));
  }

  /**
   * Drops the written stamp for a poll at or before `pollAt`. A flush of a later poll, stored
   * while the clear was in flight, is left in place.
   */
  forgetHolderStamp(mint: string, pollAt: number): void {
    const rec = this.writtenHolderStamp.get(mint);
    if (rec && rec.pollAt <= pollAt) this.writtenHolderStamp.delete(mint);
  }

  private async write(): Promise<void> {
    // Swapped before the await so stamps arriving mid-write land in the next batch instead of
    // being cleared unwritten.
    const batch = [...this.pending];
    this.pending.clear();
    const writtenAt = new Date();
    const ids = batch.map(([id]) => id);
    if (this.options.stamp === "holders") {
      for (const [mint, pollAt] of batch) this.rememberHolderStamp(mint, pollAt, writtenAt.getTime());
    }
    try {
      if (this.options.stamp === "holders") {
        await prisma.token.updateMany({
          where: { mintAddress: { in: ids } },
          data: { holdersViewedAt: writtenAt },
        });
      } else {
        await prisma.token.updateMany({
          where: { id: { in: ids } },
          data: { lastViewedAt: writtenAt },
        });
      }
    } catch (err) {
      logger.error("could not flush view stamps", { err: String(err), count: batch.length });
    }
  }

  private rememberHolderStamp(mint: string, pollAt: number, writtenAt: number): void {
    this.writtenHolderStamp.delete(mint);
    this.writtenHolderStamp.set(mint, { pollAt, writtenAt });
    while (this.writtenHolderStamp.size > 5_000) {
      const oldest = this.writtenHolderStamp.keys().next().value;
      if (oldest === undefined) break;
      this.writtenHolderStamp.delete(oldest);
    }
  }

  /**
   * Final flush for shutdown, so the last page anyone opened is not lost: waits out a write
   * already in flight (whose batch was swapped out before stamps kept arriving), then writes
   * what came in meanwhile.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing) await this.flushing;
    await this.flush();
  }
}

/**
 * The clear bound for one released poll. The column holds the flush time, which is after the poll,
 * so the bound is that written time when this buffer flushed the poll (or an earlier one). A stamp
 * from a later poll is left alone.
 */
export function holderStampClearAt(
  pollAt: number,
  written: { pollAt: number; writtenAt: number } | undefined,
): number {
  if (written && written.pollAt <= pollAt) return Math.max(pollAt, written.writtenAt);
  return pollAt;
}

/**
 * Clears bubble-map stamps a sliding watch released (user ask 2026-10-21). Not awaited by the
 * bubble-holders response. A stamp newer than the one this release wrote is left alone, so an
 * account that still has the map (and has stamped it again) keeps the fast re-read.
 */
export async function releaseHolderStamps(
  buffer: ViewStampBuffer | undefined,
  released: readonly { mint: string; at: number }[],
): Promise<void> {
  if (released.length === 0) return;
  buffer?.dismiss(released.map((row) => row.mint));
  await buffer?.settle();
  return clearReleasedHolderStamps(released, buffer);
}

async function clearReleasedHolderStamps(
  released: readonly { mint: string; at: number }[],
  buffer: ViewStampBuffer | undefined,
): Promise<void> {
  try {
    for (const row of released) {
      const until = buffer ? buffer.holderStampClearAt(row.mint, row.at) : row.at;
      await prisma.token.updateMany({
        where: { mintAddress: row.mint, holdersViewedAt: { lte: new Date(until) } },
        data: { holdersViewedAt: null },
      });
      buffer?.forgetHolderStamp(row.mint, row.at);
    }
  } catch (err) {
    logger.error("could not clear a released bubble-map stamp", {
      err: String(err),
      count: released.length,
    });
  }
}
