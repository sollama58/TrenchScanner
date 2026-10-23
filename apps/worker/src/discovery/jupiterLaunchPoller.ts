import {
  createLogger,
  RateGateDeadlineError,
  type DiscoveredCoin,
  type JupiterClient,
} from "@trenchscanner/core";

const logger = createLogger("jupiter-launch-poller");

/**
 * Jupiter's `recent` list spans about half a minute of Pump.fun launches, so each launch shows in
 * two reads. 4 calls a minute through the shared gate (50 a minute, PR #566), which the scan and
 * the other jobs used about 26 of on 2026-10-15; background priority, so the scan's own price
 * reads keep their reserve.
 */
export const LAUNCH_POLL_INTERVAL_MS = 15_000;
const MAX_BUFFERED = 2_000;

/**
 * Brand-new Pump.fun launches from Jupiter's newest-pools list, read every few seconds and held
 * for the scan, which drains them once a cycle like PumpPortal's creates.
 *
 * PumpPortal's create feed was the only source that saw every launch, and it no longer does: on
 * 2026-10-15 it sent 115 of the 210 Pump.fun launches Jupiter listed in four minutes, SOL-paired
 * and coin-paired alike (CFWw…pump, paired with tokenized Palantir, was one it never sent).
 * Pump.fun's own newest page has been behind a Cloudflare challenge since 2026-10-14, and the
 * scan's once-a-minute read of Jupiter's list saw only half of the rest, so about a third of
 * launches never reached the watchlist.
 */
export class JupiterLaunchPoller {
  private readonly buffer = new Map<string, DiscoveredCoin>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = LAUNCH_POLL_INTERVAL_MS;
  private inFlight: Promise<DiscoveredCoin[]> | null = null;
  private stats = { polls: 0, failed: 0, found: 0 };

  constructor(private readonly jupiter: Pick<JupiterClient, "recentLaunches">) {}

  start(intervalMs = LAUNCH_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.intervalMs = intervalMs;
    void this.poll();
    this.schedule();
  }

  private schedule(): void {
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One read of the list into the buffer. Visible for tests. */
  async poll(): Promise<void> {
    await this.read();
  }

  /**
   * A read of the list now, for the scan's moving-coins discovery (JupiterClient
   * discoverMovingLaunches `recent`), which read the same list a call of its own before
   * (price-market audit 2026-10-23, 4a-4): the coins it read, held for the drain as well. The next
   * timed read is a whole interval after it, so the list is read no less often than before. A
   * read already under way is joined. A failed read gives none (logged here), as the scan's own
   * failed call did.
   */
  async pollNow(): Promise<DiscoveredCoin[]> {
    if (this.timer) {
      clearInterval(this.timer);
      this.schedule();
    }
    return this.read();
  }

  /** The read under way, or a new one: the coins read, none when the read failed. */
  private read(): Promise<DiscoveredCoin[]> {
    if (this.inFlight) return this.inFlight;
    this.stats.polls += 1;
    const run = this.readOnce();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    return run;
  }

  private async readOnce(): Promise<DiscoveredCoin[]> {
    try {
      const coins = await this.jupiter.recentLaunches();
      for (const coin of coins) {
        if (this.buffer.has(coin.mintAddress)) {
          this.buffer.set(coin.mintAddress, coin);
          continue;
        }
        if (this.buffer.size >= MAX_BUFFERED) continue;
        this.buffer.set(coin.mintAddress, coin);
        this.stats.found += 1;
      }
      return coins;
    } catch (err) {
      this.stats.failed += 1;
      if (!(err instanceof RateGateDeadlineError))
        logger.warn("recent launches read failed", { error: String(err) });
      return [];
    }
  }

  /** Everything read since the last drain, and empties the buffer. */
  drain(): DiscoveredCoin[] {
    const coins = [...this.buffer.values()];
    this.buffer.clear();
    return coins;
  }

  /** The launches read since the last drain, left buffered: what EntryWatch checks between cycles. */
  pendingLaunches(): string[] {
    return [...this.buffer.keys()].reverse();
  }

  /** One launch read since the last drain, left buffered: what the entry fast path records it from. */
  pendingLaunch(mint: string): DiscoveredCoin | undefined {
    return this.buffer.get(mint);
  }

  /** Reads and launches found since the last call, then reset. */
  takeStats(): { polls: number; failed: number; found: number } {
    const out = this.stats;
    this.stats = { polls: 0, failed: 0, found: 0 };
    return out;
  }
}
