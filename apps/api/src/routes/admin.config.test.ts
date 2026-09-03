// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { loadEnv, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

/**
 * Every operational env var GET /admin/config is expected to surface, mapped to the camelCase key
 * it appears under.
 *
 * This list exists because the endpoint silently fell behind twice: RUGCHECK_CACHE_TTL_MINUTES and
 * HOLDER_GROWTH_WINDOW_MINUTES were added to the schema and never surfaced, and the Admin Config
 * tab's whole purpose is to answer "what is actually running" without opening the Render
 * dashboard. A missing entry there is invisible - the page just renders one fewer row.
 *
 * Deliberately not "assert every key in Env is exposed": secrets (JWT_SECRET, HELIUS_API_KEY,
 * DATABASE_URL) must never be, and the difference is a judgement call, not something a test can
 * infer. Adding a var here is the deliberate step that makes it operator-visible.
 */
const EXPECTED: Partial<Record<keyof Env, string>> = {
  SCAN_INTERVAL_MINUTES: "scanIntervalMinutes",
  LIVE_PRICE_INTERVAL_MINUTES: "livePriceIntervalMinutes",
  LIVE_PRICE_MAX_TRACKED: "livePriceMaxTracked",
  ACTIVE_VIEW_WINDOW_MINUTES: "activeViewWindowMinutes",
  RUGCHECK_CACHE_TTL_MINUTES: "rugCheckCacheTtlMinutes",
  HOLDER_GROWTH_WINDOW_MINUTES: "holderGrowthWindowMinutes",
  PUBLIC_APP_DOMAIN: "publicAppDomain",
  DIGEST_HOUR_UTC: "digestHourUtc",
  MCAP_FILTER_MIN: "mcapFilterMin",
  MCAP_FILTER_MAX: "mcapFilterMax",
  WATCHLIST_TTL_HOURS: "watchlistTtlHours",
  WATCHLIST_MAX_TRACKED: "watchlistMaxTracked",
  CLEANUP_HOUR_UTC: "cleanupHourUtc",
  SNAPSHOT_RETENTION_DAYS: "snapshotRetentionDays",
  STALE_TOKEN_RETENTION_DAYS: "staleTokenRetentionDays",
  OUTCOME_TRACKING_HOUR_UTC: "outcomeTrackingHourUtc",
  DATABASE_POOL_TIMEOUT_SECONDS: "databasePoolTimeoutSeconds",
};

/** Never allowed out of this endpoint, whatever else changes. */
const SECRETS: (keyof Env)[] = ["JWT_SECRET", "HELIUS_API_KEY", "DATABASE_URL", "TELEGRAM_BOT_TOKEN"];

const ADMIN_WALLET = "AdminWallet11111111111111111111111111111111";

/**
 * Calls the real route. Neither authenticateAdmin nor the /config handler touches the database -
 * the admin allow-list is config, not a table - so this needs no Postgres, which keeps it running
 * everywhere rather than skipping on a machine without one.
 */
async function fetchConfig(): Promise<Record<string, unknown>> {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: "admin-test",
      walletAddress: ADMIN_WALLET,
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/config",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  } finally {
    await app.close();
  }
}

describe("GET /admin/config", () => {
  it("returns every key the Admin Config tab is meant to show", async () => {
    // The regression this guards: RUGCHECK_CACHE_TTL_MINUTES and HOLDER_GROWTH_WINDOW_MINUTES were
    // added to the schema and never surfaced here. Nothing failed - the page just rendered one
    // fewer row, so an operator could not tell what window holder growth was measured over.
    const payload = await fetchConfig();
    const env = loadEnv();
    for (const [envKey, jsonKey] of Object.entries(EXPECTED)) {
      expect(payload[jsonKey], `${jsonKey} missing from /admin/config`).toBe(env[envKey as keyof Env]);
    }
  });

  it("reports whether Telegram is configured without leaking the token", async () => {
    const payload = await fetchConfig();
    expect(typeof payload.telegramConfigured).toBe("boolean");
  });

  it("reports the connection-pool tuning - null when the limit is left to Prisma's own default", async () => {
    // Regression target: the exact incident this pair of fields exists to make diagnosable
    // without opening the Render dashboard is "Timed out fetching a new connection from the
    // connection pool (connection limit: 9)" - both numbers the error names should be readable
    // from here. DATABASE_CONNECTION_LIMIT is optional and unset in this test's environment, so
    // the honest answer is null (a real number would claim a deliberate choice nobody made) -
    // covered separately from the EXPECTED map above because the mapping isn't a bare equality.
    const payload = await fetchConfig();
    expect(payload.databaseConnectionLimit).toBeNull();
    expect(typeof payload.databasePoolTimeoutSeconds).toBe("number");
  });

  it("never returns a secret, under any key", async () => {
    const payload = await fetchConfig();
    const env = loadEnv();
    const serialised = JSON.stringify(payload);
    for (const secret of SECRETS) {
      const value = env[secret];
      // Skip anything unset locally - an empty string would match everything.
      if (typeof value !== "string" || value.length < 8) continue;
      expect(serialised, `${secret} leaked into /admin/config`).not.toContain(value);
    }
  });

  it("403s a wallet that is not on the admin list", async () => {
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
    const app = await buildServer(env);
    try {
      const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
        userId: "someone-else",
        walletAddress: "NotAnAdmin111111111111111111111111111111111",
      });
      const res = await app.inject({
        method: "GET",
        url: "/admin/config",
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
