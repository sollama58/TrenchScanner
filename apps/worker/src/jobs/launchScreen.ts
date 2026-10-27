import { createLogger } from "@trenchscanner/core";

const logger = createLogger("launch-screen");

/** How often the launches seen since the last tick are asked about. */
export const LAUNCH_SCREEN_TICK_MS = 1_000;
/**
 * How long a launch is retried after it was first seen. A seconds-old mint is often not visible
 * to the RPC yet (confirmed-commitment lag), and comes back a second or two later; one still
 * unanswered after this has some other problem, and is left to the curve tape's round and the
 * scan's own lookup, as before this existed.
 */
export const LAUNCH_SCREEN_MAX_AGE_MS = 30_000;
/** Mints per lookup: Helius takes 100 keys a call, and each mint costs two (the mint and its PDA). */
export const LAUNCH_SCREEN_BATCH = 50;

/** Launches given up on that are remembered; a buffer holds at most 5,000 + 2,000 launches. */
const MAX_GIVEN_UP = 10_000;

export type LaunchVerdict = "clear" | "mayhem" | "pending";

/** The heartbeat's counters (ScanCycleMeta takes numbers only; the medians are left out until there is one). */
export interface LaunchScreenStats extends Record<string, number> {
  /** Lookups made (one getMultipleAccounts each). */
  calls: number;
  /** Launches asked about for the first time. */
  asked: number;
  /** Verdicts: not Mayhem (followed and watched from here), Mayhem (set aside). */
  cleared: number;
  mayhem: number;
  /** Lookups that answered nothing for a launch, retried on the next tick. */
  pending: number;
  /** Launches still unanswered at LAUNCH_SCREEN_MAX_AGE_MS: left to the round and the scan. */
  gaveUp: number;
}

const emptyStats = (): LaunchScreenStats => ({
  calls: 0,
  asked: 0,
  cleared: 0,
  mayhem: 0,
  pending: 0,
  gaveUp: 0,
});

export interface LaunchScreenOptions {
  /** The launches created since the last cycle, newest first (the stream's and Jupiter's buffers). */
  newLaunches: () => string[];
  /** Whether the launch's Mayhem flag is already known, either way (mayhemMode.ts settledMayhem). */
  settled: (mint: string) => boolean;
  /** The lookup: a verdict per mint asked (mayhemMode.ts screenLaunchVerdicts). */
  screen: (mints: string[]) => Promise<Map<string, LaunchVerdict>>;
  /** Launches just confirmed not Mayhem: the curve tape follows them from here (curveTape.ts). */
  onCleared?: (mints: string[], now: number) => void;
  now?: () => number;
}

/**
 * Screens new launches for Mayhem Mode the moment they are seen, so the entry fast path can see
 * them cross (user ask 2026-10-27: speed up the Mayhem detection).
 *
 * Before this the lookup ran only in the curve tape's round, every CURVE_TAPE_POLL_SECONDS (5 s):
 * a launch was asked about up to 5 s after PumpPortal announced it, a seconds-old mint the RPC
 * did not see yet waited for the next round, and the tape followed it (and so the entry watch
 * priced it) a round after that. Until the verdict the launch was invisible to the fast path:
 * the entry watch takes only launches confirmed not Mayhem (index.ts newLaunches), so a coin
 * that crossed the floor in that window went to the one-minute cycle instead.
 *
 * Here the launches seen since the last tick are asked about once a second, in one batched
 * lookup (the same `["mayhem-state", mint]` PDA read, cached permanently in MayhemModeCache), a
 * mint the RPC does not see yet is asked again a second later, and the ones confirmed clear are
 * handed to the curve tape at once rather than at its next round. The verdict is the same as the
 * round's and the scan's; only when it lands changes. At ~45 launches a minute that is about one
 * cheap read a second; the round's own screening still runs for whatever this one gave up on.
 */
export class LaunchScreen {
  /** When each launch not yet answered was first seen here. */
  private readonly seen = new Map<string, number>();
  /** Launches given up on, still in the launch buffer until the cycle drains it: not asked again. */
  private readonly givenUp = new Set<string>();
  private stats = emptyStats();
  private verdictMs: number[] = [];
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: LaunchScreenOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), LAUNCH_SCREEN_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick: the unanswered launches asked about, verdicts recorded. Never rejects. */
  async tick(now = this.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.screen(now);
    } catch (err) {
      logger.warn("launch screen tick failed - the launches wait for the next tick", { error: String(err) });
    } finally {
      this.busy = false;
    }
  }

  private async screen(now: number): Promise<void> {
    for (const mint of this.options.newLaunches()) {
      if (this.seen.has(mint) || this.givenUp.has(mint) || this.options.settled(mint)) continue;
      this.seen.set(mint, now);
      this.stats.asked += 1;
    }
    // A launch settled meanwhile (the round or a cycle got there first) needs nothing more; one
    // unanswered too long is left to them.
    const ask: string[] = [];
    for (const [mint, since] of this.seen) {
      if (this.options.settled(mint)) {
        this.seen.delete(mint);
        continue;
      }
      if (now - since > LAUNCH_SCREEN_MAX_AGE_MS) {
        this.seen.delete(mint);
        if (this.givenUp.size >= MAX_GIVEN_UP) this.givenUp.clear();
        this.givenUp.add(mint);
        this.stats.gaveUp += 1;
        continue;
      }
      ask.push(mint);
    }
    if (ask.length === 0) return;
    const cleared: string[] = [];
    for (let i = 0; i < ask.length; i += LAUNCH_SCREEN_BATCH) {
      const batch = ask.slice(i, i + LAUNCH_SCREEN_BATCH);
      this.stats.calls += 1;
      const verdicts = await this.options.screen(batch);
      for (const mint of batch) {
        const verdict = verdicts.get(mint) ?? "pending";
        if (verdict === "pending") {
          this.stats.pending += 1;
          continue;
        }
        const since = this.seen.get(mint);
        this.seen.delete(mint);
        if (since !== undefined) this.verdictMs.push(now - since);
        if (verdict === "clear") {
          this.stats.cleared += 1;
          cleared.push(mint);
        } else this.stats.mayhem += 1;
      }
    }
    if (cleared.length > 0) this.options.onCleared?.(cleared, now);
  }

  /** The counters since the last call, then reset. */
  takeStats(): LaunchScreenStats {
    const stats = this.stats;
    // From a launch's first sighting here to its verdict, median and worst, since the last cycle.
    if (this.verdictMs.length > 0) {
      const sorted = [...this.verdictMs].sort((a, b) => a - b);
      stats.verdictMsMedian = sorted[sorted.length >> 1]!;
      stats.verdictMsMax = sorted[sorted.length - 1]!;
    }
    this.stats = emptyStats();
    this.verdictMs = [];
    return stats;
  }

  /** Launches asked about and not yet answered (tests). */
  get waiting(): number {
    return this.seen.size;
  }
}
