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
  private inFlight = false;
  private stats = { polls: 0, failed: 0, found: 0 };

  constructor(private readonly jupiter: Pick<JupiterClient, "recentLaunches">) {}

  start(intervalMs = LAUNCH_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One read of the list into the buffer. Visible for tests. */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.stats.polls += 1;
    try {
      for (const coin of await this.jupiter.recentLaunches()) {
        if (this.buffer.has(coin.mintAddress)) {
          this.buffer.set(coin.mintAddress, coin);
          continue;
        }
        if (this.buffer.size >= MAX_BUFFERED) continue;
        this.buffer.set(coin.mintAddress, coin);
        this.stats.found += 1;
      }
    } catch (err) {
      this.stats.failed += 1;
      if (!(err instanceof RateGateDeadlineError))
        logger.warn("recent launches read failed", { error: String(err) });
    } finally {
      this.inFlight = false;
    }
  }

  /** Everything read since the last drain, and empties the buffer. */
  drain(): DiscoveredCoin[] {
    const coins = [...this.buffer.values()];
    this.buffer.clear();
    return coins;
  }

  /** The launches read since the last drain, left buffered: what BandEntryWatch checks between cycles. */
  pendingLaunches(): string[] {
    return [...this.buffer.keys()].reverse();
  }

  /** Reads and launches found since the last call, then reset. */
  takeStats(): { polls: number; failed: number; found: number } {
    const out = this.stats;
    this.stats = { polls: 0, failed: 0, found: 0 };
    return out;
  }
}
