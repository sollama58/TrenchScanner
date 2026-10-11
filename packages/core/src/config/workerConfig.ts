import type { Env } from "./env.js";

/**
 * The settings the scanning worker actually runs with, published on the scan's heartbeat (meta
 * `workerConfig` and `workerCredentials`) for the admin panel's Config section. GET /admin/config
 * otherwise reads the API's own environment, and the API and the workers are separate services
 * with their own env vars: the scan cadence, the per-cycle lookup budgets, WORKER_ROLE and whether
 * the AI reviewer has a key are only true of the process that scans.
 *
 * Keys match GET /admin/config's. Flat values only (a heartbeat meta's shape), and a credential is
 * only ever whether it is set. Settings the trainer owns (retention, training cadence) are not
 * here: the scanner's copy of them would be no truer than the API's.
 */
export function workerConfigMeta(env: Env): {
  workerConfig: Record<string, string | number | boolean | null>;
  workerCredentials: Record<string, boolean>;
} {
  return {
    workerConfig: {
      workerRole: env.WORKER_ROLE,
      scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
      fastMatchIntervalSeconds: env.FAST_MATCH_INTERVAL_SECONDS,
      livePriceIntervalMinutes: env.LIVE_PRICE_INTERVAL_MINUTES,
      livePriceMaxTracked: env.LIVE_PRICE_MAX_TRACKED,
      activeViewWindowMinutes: env.ACTIVE_VIEW_WINDOW_MINUTES,
      rugCheckCacheTtlMinutes: env.RUGCHECK_CACHE_TTL_MINUTES,
      holderGrowthWindowMinutes: env.HOLDER_GROWTH_WINDOW_MINUTES,
      mcapFilterMin: env.MCAP_FILTER_MIN,
      mcapFilterMax: env.MCAP_FILTER_MAX,
      watchlistTtlHours: env.WATCHLIST_TTL_HOURS,
      watchlistMaxTracked: env.WATCHLIST_MAX_TRACKED,
      databaseConnectionLimit: env.DATABASE_CONNECTION_LIMIT ?? null,
      databasePoolTimeoutSeconds: env.DATABASE_POOL_TIMEOUT_SECONDS,
      matchAlertGuard: env.MATCH_ALERT_GUARD,
      pumpPortalTradeFlow: env.PUMPPORTAL_TRADE_FLOW,
      rugCheckMaxLookupsPerCycle: env.RUGCHECK_MAX_LOOKUPS_PER_CYCLE,
      walletFreshnessMaxLookupsPerCycle: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE,
      walletHoldingsSource: env.WALLET_HOLDINGS_SOURCE,
      walletBalanceLookupsPerCycle: env.WALLET_BALANCE_LOOKUPS_PER_CYCLE,
      walletHoldingsMaxLookupsPerCycle: env.WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE,
      walletHoldingsCacheTtlMinutes: env.WALLET_HOLDINGS_CACHE_TTL_MINUTES,
      curatedAlertCooldownHours: env.CURATED_ALERT_COOLDOWN_HOURS,
      aiReviewMode: env.AI_REVIEW_MODE,
      aiReviewModel: env.AI_REVIEW_MODEL,
      aiTextFeatures: env.AI_TEXT_FEATURES,
      aiTextMaxPerHour: env.AI_TEXT_MAX_PER_HOUR,
    },
    workerCredentials: {
      heliusApiKey: env.HELIUS_API_KEY.length > 0,
      anthropicApiKey: env.ANTHROPIC_API_KEY.length > 0,
      solanaRpcUrl: env.SOLANA_RPC_URL.length > 0,
    },
  };
}

/**
 * workerConfigMeta read back off a heartbeat's meta: only the shapes it writes (a primitive per
 * setting, a boolean per credential), or null when the row carries none - an older worker, or a
 * scan that has not run yet.
 */
export function readWorkerConfig(meta: unknown): {
  settings: Record<string, string | number | boolean | null>;
  credentials: Record<string, boolean>;
} | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const { workerConfig, workerCredentials } = meta as Record<string, unknown>;
  if (typeof workerConfig !== "object" || workerConfig === null || Array.isArray(workerConfig)) return null;
  const settings: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(workerConfig)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) settings[k] = v as string;
  }
  const credentials: Record<string, boolean> = {};
  if (typeof workerCredentials === "object" && workerCredentials !== null) {
    for (const [k, v] of Object.entries(workerCredentials)) if (typeof v === "boolean") credentials[k] = v;
  }
  return { settings, credentials };
}
