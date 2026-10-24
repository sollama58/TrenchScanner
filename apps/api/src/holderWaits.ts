/**
 * Token views waiting for their coin's next holder reading (GET /tokens/:mint/holders/wait, user
 * decision 2026-10-24). The scanner announces each reading it writes for a coin whose bubble map is
 * open (core's notifyHolderReadingWritten); the API's LISTEN connection (MatchStream.onHolders)
 * wakes the waits for that coin, and the view reads the new list at once instead of on its next
 * 15-second poll. A missed announcement costs only that poll.
 */

/** How long one ask is held for a reading before answering "nothing yet". */
export const HOLDER_WAIT_MS = 20_000;
/** Held asks per process. Past this an ask answers at once (`pushed: false`) and the view polls. */
export const MAX_HOLDER_WAITS = 2_000;

export interface HolderWaitAnswer {
  /** A reading was written for the coin while the ask was held. */
  changed: boolean;
  /** False when no wait could be held (at capacity): the view should rely on its poll a while. */
  pushed: boolean;
}

export class HolderWaits {
  private readonly waiting = new Map<string, Set<() => void>>();
  private count = 0;

  constructor(private readonly max = MAX_HOLDER_WAITS) {}

  get size(): number {
    return this.count;
  }

  /** Wakes the waits for `mint`, or every wait with null (a LISTEN reconnect). */
  wake(mint: string | null): void {
    const sets = mint === null ? [...this.waiting.values()] : [this.waiting.get(mint)];
    for (const set of sets) for (const done of [...(set ?? [])]) done();
  }

  /** Holds until `mint`'s next reading, `ms`, or `signal` aborts (the reader left). */
  wait(mint: string, ms = HOLDER_WAIT_MS, signal?: AbortSignal): Promise<HolderWaitAnswer> {
    if (this.count >= this.max) return Promise.resolve({ changed: false, pushed: false });
    if (signal?.aborted) return Promise.resolve({ changed: false, pushed: true });
    return new Promise((resolve) => {
      let set = this.waiting.get(mint);
      if (!set) this.waiting.set(mint, (set = new Set()));
      const finish = (changed: boolean) => {
        if (!set!.delete(done)) return;
        this.count -= 1;
        if (set!.size === 0 && this.waiting.get(mint) === set) this.waiting.delete(mint);
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        resolve({ changed, pushed: true });
      };
      const done = () => finish(true);
      const aborted = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
      set.add(done);
      this.count += 1;
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
}
