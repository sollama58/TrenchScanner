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
  /** Times an endpoint answered 403 (a Cloudflare block) and was left alone for REFUSED_PAUSE_MS. */
  refused: number;
  /** Requests failed as that 403 without being sent, while their endpoint was refusing. */
  heldBackRefused: number;
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
  private stats: PumpFunGateStats = emptyStats();
  private readonly msPerToken: number;
  /** Per endpoint (endpointOf): until when a 403 holds it back, or a probe is out asking. */
  private readonly refusedUntil = new Map<string, number>();

  constructor(
    private readonly name: string,
    perMinute: number,
    private readonly burst: number,
    private readonly pauseMs = PAUSE_MS,
    private readonly now: () => number = Date.now,
    private readonly refusedPauseMs = REFUSED_PAUSE_MS,
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

  /**
   * Whether a request to `url` should fail as a 403 without being sent (see fetchJson's gate):
   * its endpoint answered 403 less than REFUSED_PAUSE_MS ago. Once that has passed one request
   * goes out to ask whether the block has lifted, and the rest wait PROBE_MS for its answer.
   *
   * Pump.fun's Cloudflare refuses Render's addresses for hours at a time (2026-10-22, -23), and
   * before this every launch lookup, launch time, live market cap, charity name and chart cache
   * still sent its request and got the 403 back. The caller gets the same 403 either way, so
   * nothing it does changes; a lifted block is noticed within REFUSED_PAUSE_MS. Kept per endpoint
   * because Pump.fun has blocked one (the coin list) while another (currently-live) answered.
   */
  refusedRecently(url: string): boolean {
    const key = endpointOf(url);
    const until = this.refusedUntil.get(key);
    if (until === undefined) return false;
    const now = this.now();
    if (now < until) {
      this.stats.heldBackRefused += 1;
      return true;
    }
    this.refusedUntil.set(key, now + PROBE_MS);
    return false;
  }

  /** The endpoint answered 403: hold its requests back for REFUSED_PAUSE_MS. */
  refused(url: string): void {
    const key = endpointOf(url);
    if (!this.refusedUntil.has(key)) {
      logger.warn("Pump.fun refused us (403) - holding that endpoint back", {
        host: this.name,
        endpoint: key,
        pauseMs: this.refusedPauseMs,
      });
    }
    this.stats.refused += 1;
    this.refusedUntil.set(key, this.now() + this.refusedPauseMs);
  }

  /** The endpoint answered something other than 403: it is no longer refusing. */
  answered(url: string): void {
    if (this.refusedUntil.size === 0) return;
    const key = endpointOf(url);
    if (this.refusedUntil.delete(key))
      logger.info("Pump.fun answered again", { host: this.name, endpoint: key });
  }

  /** Counts since the last call, then reset. */
  takeStats(): PumpFunGateStats {
    const out = this.stats;
    this.stats = emptyStats();
    return out;
  }
}

function emptyStats(): PumpFunGateStats {
  return { requests: 0, throttled: 0, heldBack: 0, refused: 0, heldBackRefused: 0 };
}

/**
 * The endpoint a URL asks, as its host and path with the coin left out: `/coins-v2/<mint>` and
 * `/coins-v2/<other mint>` are one endpoint, `/coins` and `/coins/currently-live` are two.
 */
export function endpointOf(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return (
      host +
      pathname
        .split("/")
        .map((segment) => (segment.length >= MINT_LIKE_SEGMENT ? "*" : segment))
        .join("/")
    );
  } catch {
    return url;
  }
}

/** Path segments at least this long are a mint or wallet (base58, 32-44 characters). */
const MINT_LIKE_SEGMENT = 32;

/** How long a 403 holds back its endpoint before one request asks again. */
const REFUSED_PAUSE_MS = 60_000;

/** How long the one request asking after a block has to answer before another may ask. */
const PROBE_MS = 15_000;

/** How long a 429 holds every request to the host. */
const PAUSE_MS = 30_000;

/**
 * Headers every request to a Pump.fun host carries, the way the site's own pages and TokenSage ask
 * (tokensage/resolve/resolver.py). From 2026-10-22 Pump.fun refused this service's bare requests
 * (no Origin, Node's default User-Agent) with a 403 on every probe, while TokenSage, from the same
 * Render region, sent `Origin: https://pump.fun` and a named User-Agent and was answered 5,677
 * times of 5,687 in a day (full audit 2026-10-27, DA-1). Whether the header is the whole cause is
 * shown by the gates' refusal counts after a deploy.
 */
export const PUMPFUN_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: "application/json",
  origin: "https://pump.fun",
  "user-agent": "TrenchScanner/1.0 (+https://github.com/sollama58/TrenchScanner)",
});

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
    frontendRefused: frontend.refused,
    frontendHeldBackRefused: frontend.heldBackRefused,
    swapRefused: swap.refused,
    swapHeldBackRefused: swap.heldBackRefused,
  };
}
