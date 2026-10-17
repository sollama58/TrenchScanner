import { createLogger } from "../logger.js";
import { HttpError } from "./httpClient.js";

const logger = createLogger("pumpfun-gate");

export interface PumpFunGateStats {
  /** Requests let through since the last takeStats(). */
  requests: number;
  /** Times Pump.fun answered 429 and every request to the host was paused. */
  throttled: number;
  /** Requests turned away without being sent: paused, or the minute's budget spent. */
  heldBack: number;
}

/**
 * One process's budget for one Pump.fun host (user ask 2026-10-17: don't overload Pump.fun, it
 * serves many of our jobs). Every request to the host takes a slot from a token bucket, and a 429
 * pauses all of them for PAUSE_MS. Unlike RateGate it never queues: a request with no slot fails
 * at once as a 429 (HttpError), the answer every Pump.fun caller already handles - the trade tape
 * and the candle jobs stop their run, the scan's lookups come back empty and are tried again on a
 * later cycle - so a throttled Pump.fun never stalls a scan or piles up waiting calls.
 *
 * Before it the scan's discovery, launch lookups and live market caps, the trainer's three candle
 * jobs and the API's chart caches each kept their own limits or none, and a 429 slowed only the
 * job that got it (and its retry went straight back in).
 */
export class PumpFunGate {
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private stats: PumpFunGateStats = { requests: 0, throttled: 0, heldBack: 0 };
  private readonly msPerToken: number;

  constructor(
    private readonly name: string,
    perMinute: number,
    private readonly burst: number,
    private readonly pauseMs = PAUSE_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.msPerToken = 60_000 / Math.max(1, perMinute);
    this.tokens = Math.max(1, burst);
    this.refilledAt = this.now();
  }

  /** Takes a slot, or throws a 429 HttpError without waiting when there is none. */
  acquire(): Promise<void> {
    const now = this.now();
    // A clock that stepped back (a test's) would otherwise leave the bucket unrefilled until it
    // caught up again; after a pause the refill starts at the pause's end.
    if (now < this.refilledAt && now >= this.pausedUntil) this.refilledAt = now;
    if (now > this.refilledAt) {
      this.tokens = Math.min(
        Math.max(1, this.burst),
        this.tokens + (now - this.refilledAt) / this.msPerToken,
      );
      this.refilledAt = now;
    }
    if (now < this.pausedUntil || this.tokens < 1) {
      this.stats.heldBack += 1;
      return Promise.reject(new HttpError(429, this.name, `${this.name}: held back by our own budget`));
    }
    this.tokens -= 1;
    this.stats.requests += 1;
    return Promise.resolve();
  }

  /** Pump.fun answered 429: every request to the host waits out the longer of its delay and PAUSE_MS. */
  throttled(delayMs: number): void {
    const now = this.now();
    const until = now + Math.max(delayMs, this.pauseMs);
    if (now >= this.pausedUntil) {
      this.stats.throttled += 1;
      logger.warn("Pump.fun rate-limited us - pausing every request to it", {
        host: this.name,
        pauseMs: until - now,
      });
    }
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.tokens = 0;
      this.refilledAt = until;
    }
  }

  /** Counts since the last call, then reset. */
  takeStats(): PumpFunGateStats {
    const out = this.stats;
    this.stats = { requests: 0, throttled: 0, heldBack: 0 };
    return out;
  }
}

/** How long a 429 holds every request to the host. */
const PAUSE_MS = 30_000;

/**
 * The process's gates, one per host. frontend-api: the scan's discovery (about 14 a cycle at
 * once), launch lookups (up to 60 a cycle) and live market caps. swap-api: the trade tape, the
 * trainer's candle jobs (up to about 180 a minute) and the API's charts.
 */
export const pumpFunFrontendGate = new PumpFunGate("frontend-api.pump.fun", 300, 60);
export const pumpFunSwapGate = new PumpFunGate("swap-api.pump.fun", 240, 40);

/** The gates' counts since the last call, flat for a job's heartbeat. */
export function takePumpFunGateStats(): Record<string, number> {
  const frontend = pumpFunFrontendGate.takeStats();
  const swap = pumpFunSwapGate.takeStats();
  return {
    frontendRequests: frontend.requests,
    frontendThrottled: frontend.throttled,
    frontendHeldBack: frontend.heldBack,
    swapRequests: swap.requests,
    swapThrottled: swap.throttled,
    swapHeldBack: swap.heldBack,
  };
}
