/**
 * The extension's boards waiting for new numbers on their coins (POST /ext/v1/stats/wait, user ask
 * 2026-10-27: live board pills). The scanner announces the snapshots it writes (core's
 * noteSnapshotForBoards); the API's LISTEN connection (MatchStream.onSnapshots) wakes each wait
 * that names one of those coins, and the board reads their new numbers at once instead of on its
 * next 30-second ask. A missed announcement costs only that ask.
 */

/** How long one ask is held for new numbers before answering "nothing yet". */
export const BOARD_WAIT_MS = 25_000;
/** Held asks per process. Past this an ask answers at once (`pushed: false`) and the board polls. */
export const MAX_BOARD_WAITS = 2_000;
/** After the first coin changes, other coins' notices are gathered this long into the same answer. */
export const BOARD_GATHER_MS = 300;

export interface BoardWaitAnswer {
  /** The coins asked about that got a snapshot while the ask was held; empty when none did. */
  changed: string[];
  /** False when no wait could be held (at capacity): the board should rely on its own re-ask. */
  pushed: boolean;
}

interface Waiter {
  mints: ReadonlySet<string>;
  changed: Set<string>;
  wake(): void;
}

export class BoardWaits {
  private readonly byMint = new Map<string, Set<Waiter>>();
  private count = 0;

  constructor(
    private readonly max = MAX_BOARD_WAITS,
    private readonly gatherMs = BOARD_GATHER_MS,
  ) {}

  get size(): number {
    return this.count;
  }

  /**
   * Wakes the waits that name any of `mints`. With null (a LISTEN reconnect, when notices may have
   * been missed) every wait answers at once with no coins: re-reading every board's coins at the
   * same moment would be a stampede, and each board's own re-ask reads them soon enough.
   */
  wake(mints: readonly string[] | null): void {
    if (mints === null) {
      const all = new Set<Waiter>();
      for (const set of this.byMint.values()) for (const w of set) all.add(w);
      for (const w of all) w.wake();
      return;
    }
    for (const mint of mints) {
      for (const w of [...(this.byMint.get(mint) ?? [])]) {
        w.changed.add(mint);
        w.wake();
      }
    }
  }

  /** Holds until one of `mints` gets new numbers, `ms`, or `signal` aborts (the board left). */
  wait(mints: readonly string[], ms = BOARD_WAIT_MS, signal?: AbortSignal): Promise<BoardWaitAnswer> {
    if (mints.length === 0 || signal?.aborted) return Promise.resolve({ changed: [], pushed: true });
    if (this.count >= this.max) return Promise.resolve({ changed: [], pushed: false });
    return new Promise((resolve) => {
      let gather: NodeJS.Timeout | undefined;
      let done = false;
      const waiter: Waiter = {
        mints: new Set(mints),
        changed: new Set(),
        wake: () => {
          if (gather || done) return;
          gather = setTimeout(finish, this.gatherMs);
          gather.unref?.();
        },
      };
      const finish = () => {
        if (done) return;
        done = true;
        this.count -= 1;
        for (const mint of waiter.mints) {
          const set = this.byMint.get(mint);
          set?.delete(waiter);
          if (set && set.size === 0) this.byMint.delete(mint);
        }
        clearTimeout(timer);
        clearTimeout(gather);
        signal?.removeEventListener("abort", finish);
        resolve({ changed: [...waiter.changed], pushed: true });
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      for (const mint of waiter.mints) {
        let set = this.byMint.get(mint);
        if (!set) this.byMint.set(mint, (set = new Set()));
        set.add(waiter);
      }
      this.count += 1;
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
