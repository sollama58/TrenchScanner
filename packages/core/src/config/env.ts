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

  // One minute. Not a performance figure - a full cycle takes ~10 seconds - but a rate-limit one:
  // RugCheck is called once per in-band candidate per cycle, so this interval used to multiply its
  // traffic one-for-one and was held at 7 minutes because of it. RUGCHECK_CACHE_TTL_MINUTES below
  // breaks that coupling, which is what makes a one-minute alert loop affordable.
  SCAN_INTERVAL_MINUTES: z.coerce.number().positive().default(1),
  // How long a RugCheck report is reused before being re-fetched (see the worker's
  // rugCheckProfiles.ts). Short, because everything RugCheck reports is mutable - holder
  // distribution, dev wallet %, risk score - unlike mint authority revocation or Mayhem Mode,
  // which are cached permanently. Raising this cuts RugCheck traffic and makes the holder and
  // risk figures staler; it does not slow down how fast a *new* alert can appear, since a mint
  // that has never been screened is always a cache miss.
  RUGCHECK_CACHE_TTL_MINUTES: z.coerce.number().positive().default(5),
  // The wall-clock span holderGrowthPct is measured over: growth is compared against the newest
  // snapshot at least this old, rather than against whatever the previous snapshot happened to be.
  // Anchoring it this way is what keeps the number's meaning independent of SCAN_INTERVAL_MINUTES
  // - see the comment at its use site in the worker's scanJob.ts. Must comfortably exceed
  // RUGCHECK_CACHE_TTL_MINUTES, or a cached holder count on both sides of the comparison would
  // make growth read 0 rather than "unmeasured".
  HOLDER_GROWTH_WINDOW_MINUTES: z.coerce.number().positive().default(30),
  DIGEST_HOUR_UTC: z.coerce.number().min(0).max(23).default(13),
  MCAP_FILTER_MIN: z.coerce.number().nonnegative().default(10_000),
  MCAP_FILTER_MAX: z.coerce.number().positive().default(1_000_000),
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

  // How often the live-price job refreshes market data for tokens someone currently has open
  // (see apps/worker/src/jobs/livePriceJob.ts). Much faster than SCAN_INTERVAL_MINUTES because
  // it is far cheaper: market data only, one batched DexScreener call per 30 tokens, no RugCheck
  // or Helius work and no scoring/matching. Safety cap on how many tokens one pass will refresh,
  // so an unexpectedly large viewed set can't turn a per-minute job into a DexScreener hammer.
  LIVE_PRICE_INTERVAL_MINUTES: z.coerce.number().positive().default(1),
  LIVE_PRICE_MAX_TRACKED: z.coerce.number().int().positive().default(150),

  // Daily cleanup job (see apps/worker/src/jobs/cleanupJob.ts) - prunes TokenSnapshot rows older
  // than this that aren't referenced by any Match (deleting a referenced one would cascade-delete
  // real match history), and Token rows older than this with zero snapshots and zero matches ever
  // (dead watchlist entries). Both tables would otherwise grow unbounded forever.
  // SNAPSHOT_RETENTION_DAYS doubles as the horizon for peak recovery: recordMatchPeaks
  // (apps/worker/src/jobs/matchPeaks.ts) mines a match's peak out of its token's snapshot history,
  // and once those snapshots are pruned there is nothing left to mine, so it doesn't look further
  // back than this.
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

  // The dashboard's real, canonical host[:port] (no protocol) - e.g. "holdex.live"
  // in production, "localhost:5173" for local dev. This is the anti-phishing anchor for Sign-In
  // With Solana: it's embedded in every sign-in message as the EIP-4361 `domain` field, which
  // Wallet-Standard-compliant wallets (Phantom, Solflare) cross-check against the page's actual
  // origin before signing - a phishing site simply cannot get a wallet to sign a message claiming
  // this domain while running on a different one. Must be updated if the dashboard's real domain
  // changes (same caveat CORS_ORIGINS already has). The dashboard is served by the CultScreener/
  // HolDEX site (its /trenches/ tab), not from this repo's own Render blueprint.
  PUBLIC_APP_DOMAIN: z.string().default("localhost:5173"),

  // Comma-separated base58 wallet addresses allowed into the Admin Panel (GET/POST /admin/*) -
  // see apps/api/src/routes/admin.ts. Deliberately config, not a DB column: there's no
  // chicken-and-egg "how does the first admin get flagged" problem, and promoting/demoting an
  // admin is a one-line env change + redeploy rather than a manual DB write. Empty by default,
  // which means the Admin Panel is unreachable (every request 403s) until explicitly configured.
  ADMIN_WALLET_ADDRESSES: z.string().optional().default(""),

  // Where the burn reconciler and the claim endpoint read the chain.
  //
  // Set this. The default is the public mainnet RPC, and measurement against the real endpoints
  // shows why that is a stopgap rather than a configuration:
  //   - api.mainnet-beta.solana.com rate-limits a cold start into a stutter (429s within seconds
  //     of starting a first scan), though it does support batching and proper pagination.
  //   - solana-rpc.publicnode.com rejects JSON-RPC batches outright with a 400, and caps
  //     getSignaturesForAddress at ~86 results while ignoring `before` - so a cold start on it
  //     silently sees only recent history.
  // The client copes with both (it falls back to unbatched fetching and never advances its cursor
  // over anything it failed to read), but "copes" is not the same as "is fine": this is the path
  // that decides whether someone who paid gets what they paid for.
  //
  // Kept separate from HELIUS_API_KEY so the two can diverge - the enrichment path can tolerate a
  // throttled RPC, this one cannot.
  SOLANA_RPC_URL: z.string().optional().default(""),

  // How often the reconciler sweeps the chain for burns nobody claimed. This is the backstop that
  // makes the promise "if you burn, you get access" true even when the browser never reports in,
  // so it runs on a tight-ish loop rather than daily.
  BURN_SCAN_INTERVAL_MINUTES: z.coerce.number().positive().default(3),

  // How far back a cold start looks. Only used when there is no cursor yet (a fresh deploy, or a
  // wiped BurnScanCursor); after that every pass walks forward from where the last one stopped.
  // Bounded so a first run doesn't try to page through the mint's entire history.
  //
  // The default is sized to the product, not to politeness: a single burn can buy up to
  // MAX_MONTHS_PER_BURN (12) months, so the disaster-recovery path - rebuild the ledger by
  // rescanning the chain - has to be able to see a burn that far back, or the people who paid
  // the most are exactly the ones a rebuild would drop. 400 days = 12 months + margin. At this
  // mint's measured ~53 tx/day that is ~21k signatures, which the cursor walks across a few
  // passes; it is a one-time cost on a fresh install, not a recurring one.
  BURN_SCAN_COLD_START_DAYS: z.coerce.number().positive().default(400),
});

/**
 * Holder growth is measured across HOLDER_GROWTH_WINDOW_MINUTES, but the holder count on each end
 * of that comparison can be up to RUGCHECK_CACHE_TTL_MINUTES stale. If the window is not clearly
 * the larger of the two, both readings can come from the same cached report and growth reads a
 * confident 0% - which is not "no growth", it is "not measured", and nothing downstream can tell
 * the difference. Cheap to state here; expensive to diagnose in production.
 */
const validatedEnvSchema = envSchema.refine(
  (env) => env.HOLDER_GROWTH_WINDOW_MINUTES > env.RUGCHECK_CACHE_TTL_MINUTES,
  {
    path: ["HOLDER_GROWTH_WINDOW_MINUTES"],
    message:
      "HOLDER_GROWTH_WINDOW_MINUTES must be greater than RUGCHECK_CACHE_TTL_MINUTES, or holder growth is measured between two readings of the same cached report and always reads 0%",
  },
);

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses `process.env` once and caches the result. Throws with a readable message on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = validatedEnvSchema.safeParse(source);
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
