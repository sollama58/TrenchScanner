import type { FastifyInstance } from "fastify";

/**
 * Rate-limit buckets held in memory, across every route (one entry per caller per route). The
 * plugin's default of 5,000 is a least-recently-used map: a few thousand rotating source addresses
 * pushed every real caller's bucket out, and an evicted bucket starts again at zero, so every
 * limit - the sign-in ones and the per-user Helius budgets alike - stopped holding exactly when
 * it mattered. An entry is a couple of hundred bytes, so this is ~20MB at the worst.
 */
export const RATE_LIMIT_BUCKETS = 100_000;

/**
 * A route's own `config.rateLimit` gets a store of its own, sized by that config's `cache` and not
 * the plugin's: without it each route-level limit (sign-in, 2FA, the paid lookups) sat in a
 * 5,000-entry LRU that rotating callers flush (audit 2026-10-23, CE-9). Call it before registering
 * @fastify/rate-limit, so this onRoute hook runs before the plugin's reads the config. The
 * extension routes (/ext/v1 and its keys) are sized too: left at 5,000, a key holder rotating
 * addresses flushed their own key's bucket and every Trade Buddy limit with it (audit 2026-10-27, AP-3).
 */
export function sizeRouteRateLimits(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    const limit = route.config?.rateLimit;
    if (typeof limit !== "object" || limit === null || "cache" in limit) return;
    route.config = { ...route.config, rateLimit: { ...limit, cache: RATE_LIMIT_BUCKETS } };
  });
}
