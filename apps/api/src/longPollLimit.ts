import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ipRateLimitKey } from "./clientIp.js";

/**
 * The rate limits of the charts' long polls: the live tail (/chart/live) and Live trades
 * (/trades/live), under /tokens and /utilities/token. One busy chart asks up to about 80 times a
 * minute (a 750 ms gap, #719). Keyed by user and device alone, two or three open charts (Scope
 * tabs, several windows) ran each other into 429s and the client backed off for up to 30 s
 * (charts audit item 7, user ask 2026-10-19 "fix all"). Now each coin has its own bucket per user
 * and device, and a per-user ceiling over every coin keeps the total bounded.
 */

/** One reader's asks a minute about one coin, per feed: one open chart at ~80, with room. */
export const LONG_POLL_PER_MINT = 120;
/** One reader's asks a minute over every coin, per feed: about six open charts at 80 each, with room. */
export const LONG_POLL_PER_USER = 600;

/** The route's rate limit: per user, device and coin (`param` names the mint in the route). */
export function longPollRateLimit(app: FastifyInstance, param: "mintAddress" | "mint") {
  return {
    max: LONG_POLL_PER_MINT,
    timeWindow: "1 minute",
    keyGenerator: async (request: FastifyRequest): Promise<string> => {
      const base = app.hasDecorator("rateLimitKey")
        ? await app.rateLimitKey(request)
        : ipRateLimitKey(request);
      const mint = (request.params as Record<string, unknown> | undefined)?.[param];
      return `${base}:${typeof mint === "string" ? mint.slice(0, 64) : ""}`;
    },
  };
}

/** Fixed one-minute windows per key, bounded to `maxKeys` (the oldest key first out). */
export class LongPollCeiling {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute = LONG_POLL_PER_USER,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one ask for `key`; whether it is within the ceiling. */
  allow(key: string): boolean {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      this.windows.delete(key);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      while (this.windows.size > this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest === undefined) break;
        this.windows.delete(oldest);
      }
    }
    w.count += 1;
    return w.count <= this.perMinute;
  }
}

/** The process's ceiling, shared by the /tokens and /utilities/token long polls. */
const ceiling = new LongPollCeiling();

/**
 * Whether the reader is within their ceiling for `feed`; past it, answers 429 and returns false.
 * Call after authentication (it reads request.user).
 */
export function withinLongPollCeiling(
  request: FastifyRequest,
  reply: FastifyReply,
  feed: "chart-live" | "trades-live" | "holders-wait",
): boolean {
  const user = request.user?.userId;
  if (!user || ceiling.allow(`${feed}:${user}`)) return true;
  void reply
    .code(429)
    .header("Retry-After", "5")
    .send({ error: "Too many live chart reads open at once; close a chart or wait a few seconds." });
  return false;
}
