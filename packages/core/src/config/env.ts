import { z } from "zod";

/**
 * Central env schema shared by the api and worker apps. Each app calls
 * `loadEnv()` once at startup; failing fast with a clear message beats a
 * confusing runtime crash three layers down.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Only apps/api actually uses this (to sign session JWTs) - apps/worker never touches it, but
  // both share this one schema. Rather than force every consumer to configure a secret it
  // doesn't need, this falls back to an obviously-insecure default and apps/api itself checks
  // for and warns loudly about that default at startup (see apps/api/src/index.ts) - so a real
  // deployment can't silently ship with it, but the worker's startup is never blocked by it.
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters")
    .default("dev-insecure-default-jwt-secret-change-me"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),

  HELIUS_API_KEY: z.string().optional().default(""),
  DEXSCREENER_BASE_URL: z.string().default("https://api.dexscreener.com"),
  PUMPFUN_BASE_URL: z.string().default("https://frontend-api-v3.pump.fun"),

  SCAN_INTERVAL_MINUTES: z.coerce.number().positive().default(7),
  DIGEST_HOUR_UTC: z.coerce.number().min(0).max(23).default(13),
  MCAP_FILTER_MIN: z.coerce.number().nonnegative().default(50_000),
  MCAP_FILTER_MAX: z.coerce.number().positive().default(500_000),
  // How long a discovered mint stays on the active watchlist (re-checked every scan cycle) before
  // it's considered stale and dropped. Most tokens that haven't gained traction go quiet well
  // before this; it exists to bound DexScreener batch-lookup volume per cycle.
  WATCHLIST_TTL_HOURS: z.coerce.number().positive().default(24),
  WATCHLIST_MAX_TRACKED: z.coerce.number().int().positive().default(900),
  // How long after GET /matches last stamped a token's lastViewedAt (i.e. someone had it on a
  // Live Feed page) the scan job keeps re-scanning it even if it's fallen out of the mcap band -
  // see the comment on Token.lastViewedAt. Comfortably longer than one scan cycle so a token
  // being actively watched never goes a full cycle without a check due to poll/scan timing
  // jitter, but short enough that closing the tab lets a long-dead winner's tracking lapse.
  ACTIVE_VIEW_WINDOW_MINUTES: z.coerce.number().positive().default(10),

  // Daily cleanup job (see apps/worker/src/jobs/cleanupJob.ts) - prunes TokenSnapshot rows older
  // than this that aren't referenced by any Match (deleting a referenced one would cascade-delete
  // real match history), and Token rows older than this with zero snapshots and zero matches ever
  // (dead watchlist entries). Both tables would otherwise grow unbounded forever.
  CLEANUP_HOUR_UTC: z.coerce.number().min(0).max(23).default(4),
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().positive().default(30),
  STALE_TOKEN_RETENTION_DAYS: z.coerce.number().positive().default(90),

  // Daily outcome-tracking job (see apps/worker/src/jobs/outcomeTrackingJob.ts) - backtesting
  // data: re-checks recent Match rows against live market data and records the highest mcap seen
  // since the match, so scoring quality can eventually be measured against real outcomes. Runs an
  // hour after cleanup purely to keep the two daily jobs from overlapping on a cold start.
  OUTCOME_TRACKING_HOUR_UTC: z.coerce.number().min(0).max(23).default(5),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  // Used only to build the "tap to open Telegram" deep link on the dashboard - not required
  // for the bot itself to function, but without it users have to type /start <code> manually.
  TELEGRAM_BOT_USERNAME: z.string().optional().default(""),

  API_PORT: z.coerce.number().positive().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  // The dashboard's real, canonical host[:port] (no protocol) - e.g. "trenchscanner-web.onrender.com"
  // in production, "localhost:5173" for local dev. This is the anti-phishing anchor for Sign-In
  // With Solana: it's embedded in every sign-in message as the EIP-4361 `domain` field, which
  // Wallet-Standard-compliant wallets (Phantom, Solflare) cross-check against the page's actual
  // origin before signing - a phishing site simply cannot get a wallet to sign a message claiming
  // this domain while running on a different one. Must be updated if the dashboard's real domain
  // changes (same caveat as CORS_ORIGINS/VITE_API_URL already have).
  PUBLIC_APP_DOMAIN: z.string().default("localhost:5173"),

  // Comma-separated base58 wallet addresses allowed into the Admin Panel (GET/POST /admin/*) -
  // see apps/api/src/routes/admin.ts. Deliberately config, not a DB column: there's no
  // chicken-and-egg "how does the first admin get flagged" problem, and promoting/demoting an
  // admin is a one-line env change + redeploy rather than a manual DB write. Empty by default,
  // which means the Admin Panel is unreachable (every request 403s) until explicitly configured.
  ADMIN_WALLET_ADDRESSES: z.string().optional().default(""),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses `process.env` once and caches the result. Throws with a readable message on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only: clears the cached env so a fresh loadEnv() re-parses. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}

export function corsOriginList(env: Env): string[] {
  return env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses ADMIN_WALLET_ADDRESSES into a lookup set. Same comma-separated-list shape as CORS_ORIGINS. */
export function adminWalletSet(env: Env): Set<string> {
  return new Set(
    env.ADMIN_WALLET_ADDRESSES.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
