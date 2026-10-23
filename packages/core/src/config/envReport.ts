import { createHash } from "node:crypto";
import { prisma } from "../db.js";

/**
 * Admin > Environment (user ask 2026-10-23): which of the env vars each service is meant to have
 * are actually set on it. Render keeps each service's variables apart, and a variable added to one
 * service's Environment tab is easily missed on another (TOKENSAGE_XREUSE_RESTORED_AT on the
 * trainer, COINGECKO_API_KEY on the api, HELIUS_MONTHLY_CREDITS on the scanner), with nothing but
 * the dashboard to check it in.
 *
 * Each process reports on itself: the api live from its own environment, each worker at boot into
 * ServiceEnvReport (a worker has no HTTP port the api could ask). A report never carries a value
 * that could be a credential: a secret is its length and a fingerprint the api compares across
 * services but never sends on, a URL is its origin, and only plain settings (numbers, switches,
 * public addresses) carry their value.
 */

/** The Node services that report. "all" is local dev's one process running every role. */
export type EnvService = "api" | "scanner" | "trainer";

/**
 * How much a missing variable matters on a service. "required": the service misbehaves without it.
 * "expected": render.yaml ships a value, or it is a credential this deployment uses, so missing is
 * a slip. "optional": a feature that stays off when unset.
 */
export type EnvNeed = "required" | "expected" | "optional";

/** What a report may say about the value: see the file comment. */
export type EnvKind = "secret" | "url" | "setting";

export interface EnvVarSpec {
  key: string;
  group: string;
  kind: EnvKind;
  /** The services the variable belongs on, and how much it matters on each. */
  on: Partial<Record<EnvService, EnvNeed>>;
  /** Meant to hold the same value on every service it is on (compared, never shown). */
  same?: boolean;
  note?: string;
}

const ALL: Record<EnvService, EnvNeed> = { api: "expected", scanner: "expected", trainer: "expected" };
const WORKERS: Partial<Record<EnvService, EnvNeed>> = { scanner: "expected", trainer: "expected" };

/**
 * Every variable render.yaml declares on the api, the scanner (trenchscanner-worker) and the
 * trainer, plus the few set by hand that it only describes in comments. envReport.test.ts holds
 * this to render.yaml, so a variable added there and not here fails CI.
 */
export const ENV_MANIFEST: readonly EnvVarSpec[] = [
  // ---- Core
  {
    key: "NODE_ENV",
    group: "Core",
    kind: "setting",
    on: { api: "required", scanner: "required", trainer: "required" },
    same: true,
  },
  {
    key: "DATABASE_URL",
    group: "Core",
    kind: "url",
    on: { api: "required", scanner: "required", trainer: "required" },
    same: true,
  },
  {
    key: "DATABASE_CONNECTION_LIMIT",
    group: "Core",
    kind: "setting",
    on: ALL,
    note: "Pool size per service; sized in render.yaml.",
  },
  { key: "DATABASE_SOCKET_TIMEOUT_SECONDS", group: "Core", kind: "setting", on: { trainer: "expected" } },
  { key: "WORKER_ROLE", group: "Core", kind: "setting", on: { scanner: "required", trainer: "required" } },
  {
    key: "WALLET_TAG_SECRET",
    group: "Core",
    kind: "secret",
    on: ALL,
    same: true,
    note: "Same on every service, so one wallet's log tag matches across them.",
  },
  // ---- Data providers
  {
    key: "HELIUS_API_KEY",
    group: "Data providers",
    kind: "secret",
    on: { api: "required", scanner: "required" },
    same: true,
  },
  {
    key: "HELIUS_MONTHLY_CREDITS",
    group: "Data providers",
    kind: "setting",
    on: { scanner: "expected" },
    note: "The plan's credits, for the credit gauge and the stand-down.",
  },
  { key: "HELIUS_CYCLE_START_DAY", group: "Data providers", kind: "setting", on: { scanner: "expected" } },
  {
    key: "COINGECKO_API_KEY",
    group: "Data providers",
    kind: "secret",
    on: ALL,
    same: true,
    note: "Paid CoinGecko plan; without it market data falls back to the free 30 calls a minute.",
  },
  { key: "JUPITER_API_KEY", group: "Data providers", kind: "secret", on: { scanner: "optional" } },
  {
    key: "SOLANA_TRACKER_API_KEY",
    group: "Data providers",
    kind: "secret",
    on: { scanner: "optional" },
    note: "The daily KOL roster.",
  },
  {
    key: "SOLANA_RPC_URL",
    group: "Data providers",
    kind: "url",
    on: { api: "optional", scanner: "optional" },
    note: "Empty uses the Helius RPC.",
  },
  { key: "CHAIN_BACKUP_RPC_URLS", group: "Data providers", kind: "secret", on: { scanner: "optional" } },
  { key: "DEXSCREENER_BASE_URL", group: "Data providers", kind: "url", on: ALL },
  {
    key: "DEXSCREENER_REQUESTS_PER_MINUTE",
    group: "Data providers",
    kind: "setting",
    on: { trainer: "expected" },
  },
  { key: "PUMPFUN_BASE_URL", group: "Data providers", kind: "url", on: ALL },
  // ---- TokenSage
  {
    key: "TOKENSAGE_ENABLED",
    group: "TokenSage",
    kind: "setting",
    on: { api: "optional", scanner: "optional", trainer: "optional" },
    same: true,
    note: "Set the same on all three: it decides the Narrative seat in each.",
  },
  {
    key: "TOKENSAGE_API_URL",
    group: "TokenSage",
    kind: "url",
    on: { api: "expected", scanner: "expected" },
    same: true,
  },
  { key: "TOKENSAGE_API_KEY", group: "TokenSage", kind: "secret", on: { scanner: "expected" } },
  {
    key: "TOKENSAGE_MONITOR_KEY",
    group: "TokenSage",
    kind: "secret",
    on: { api: "expected" },
    note: "TokenSage's read-only key: its usage and its env check here.",
  },
  {
    key: "TOKENSAGE_ADMIN_KEY",
    group: "TokenSage",
    kind: "secret",
    on: { api: "optional" },
    note: "Deprecated: TOKENSAGE_MONITOR_KEY replaces it.",
  },
  {
    key: "TOKENSAGE_XREUSE_RESTORED_AT",
    group: "TokenSage",
    kind: "setting",
    on: ALL,
    same: true,
    note: "When TokenSage's X-reuse counts were whole again (plus a day).",
  },
  // ---- AI
  {
    key: "ANTHROPIC_API_KEY",
    group: "AI",
    kind: "secret",
    on: WORKERS,
    same: true,
    note: "The AI reviewer, playbook evolution and text features.",
  },
  // ---- Sign-in and access
  { key: "JWT_SECRET", group: "Sign-in and access", kind: "secret", on: { api: "required" } },
  { key: "SESSION_TTL_HOURS", group: "Sign-in and access", kind: "setting", on: { api: "expected" } },
  { key: "PRIVY_APP_ID", group: "Sign-in and access", kind: "setting", on: { api: "expected" } },
  { key: "PRIVY_APP_SECRET", group: "Sign-in and access", kind: "secret", on: { api: "expected" } },
  { key: "PRIVY_JWKS_ENDPOINT", group: "Sign-in and access", kind: "url", on: { api: "expected" } },
  { key: "PRIVY_SIGNUP_CAP", group: "Sign-in and access", kind: "setting", on: { api: "expected" } },
  { key: "CORS_ORIGINS", group: "Sign-in and access", kind: "setting", on: { api: "expected" } },
  { key: "PUBLIC_APP_DOMAIN", group: "Sign-in and access", kind: "setting", on: { api: "expected" } },
  {
    key: "ADMIN_WALLET_ADDRESSES",
    group: "Sign-in and access",
    kind: "setting",
    on: { api: "required", scanner: "expected" },
    same: true,
  },
  { key: "STATS_API_TOKEN", group: "Sign-in and access", kind: "secret", on: { api: "optional" } },
  // ---- Alerts
  {
    key: "TELEGRAM_BOT_TOKEN",
    group: "Alerts",
    kind: "secret",
    on: { api: "optional", scanner: "optional" },
    same: true,
  },
  { key: "TELEGRAM_WEBHOOK_URL", group: "Alerts", kind: "url", on: { api: "expected" } },
  { key: "TELEGRAM_DASHBOARD_URL", group: "Alerts", kind: "url", on: { scanner: "expected" } },
  {
    key: "WEB_PUSH_PUBLIC_KEY",
    group: "Alerts",
    kind: "secret",
    on: { api: "optional", scanner: "optional" },
    same: true,
  },
  { key: "WEB_PUSH_PRIVATE_KEY", group: "Alerts", kind: "secret", on: { scanner: "optional" } },
  // ---- Trading
  { key: "PRO_TRADING_PUBLIC", group: "Trading", kind: "setting", on: ALL },
  { key: "PRO_TRADING_JUPITER_API_KEY", group: "Trading", kind: "secret", on: { api: "optional" } },
  { key: "HELIUS_SENDER_URL", group: "Trading", kind: "url", on: { api: "optional" } },
  {
    key: "TRADING_BACKUP_RPC_URL",
    group: "Trading",
    kind: "url",
    on: { api: "expected" },
    note: "The second RPC a Pro trade sends through.",
  },
  { key: "TRADING_BOT_ENABLED", group: "Trading", kind: "setting", on: { api: "expected" } },
  { key: "TRADING_KMS_KEY_ID", group: "Trading", kind: "secret", on: { api: "optional" } },
  { key: "TRADING_KMS_REGION", group: "Trading", kind: "setting", on: { api: "expected" } },
  { key: "TRADING_AWS_ACCESS_KEY_ID", group: "Trading", kind: "secret", on: { api: "optional" } },
  { key: "TRADING_AWS_SECRET_ACCESS_KEY", group: "Trading", kind: "secret", on: { api: "optional" } },
  { key: "TRADING_SERVER_WALLET_ADDRESS", group: "Trading", kind: "setting", on: { api: "optional" } },
  { key: "TRADING_SERVER_WALLET_WITHDRAW_TO", group: "Trading", kind: "setting", on: { api: "optional" } },
  // ---- Backups
  { key: "DB_DUMP_S3_ENDPOINT", group: "Backups", kind: "url", on: { api: "optional" } },
  { key: "DB_DUMP_S3_BUCKET", group: "Backups", kind: "setting", on: { api: "optional" } },
  { key: "DB_DUMP_S3_ACCESS_KEY_ID", group: "Backups", kind: "secret", on: { api: "optional" } },
  { key: "DB_DUMP_S3_SECRET_ACCESS_KEY", group: "Backups", kind: "secret", on: { api: "optional" } },
  { key: "MODEL_BACKUP_S3_ENDPOINT", group: "Backups", kind: "url", on: { trainer: "optional" } },
  { key: "MODEL_BACKUP_S3_BUCKET", group: "Backups", kind: "setting", on: { trainer: "optional" } },
  { key: "MODEL_BACKUP_S3_ACCESS_KEY_ID", group: "Backups", kind: "secret", on: { trainer: "optional" } },
  { key: "MODEL_BACKUP_S3_SECRET_ACCESS_KEY", group: "Backups", kind: "secret", on: { trainer: "optional" } },
  // ---- Scan tuning (the scanner's render.yaml overrides of env.ts defaults)
  ...[
    "SCAN_INTERVAL_MINUTES",
    "ENTRY_FAST_PATH_ENABLED",
    "ENTRY_FAST_PATH_MAX_PER_MINUTE",
    "WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE",
    "WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE",
    "LIVE_TAPE_PAGES_PER_CYCLE",
    "RUGCHECK_CACHE_TTL_MINUTES",
    "HOLDER_GROWTH_WINDOW_MINUTES",
    "WATCHLIST_TTL_HOURS",
    "WATCHLIST_MAX_TRACKED",
    "DB_DISK_ALERT_MB",
    "ACTIVE_VIEW_WINDOW_MINUTES",
    "LIVE_PRICE_INTERVAL_MINUTES",
    "LIVE_PRICE_MAX_TRACKED",
  ].map((key): EnvVarSpec => ({ key, group: "Scan tuning", kind: "setting", on: { scanner: "expected" } })),
  // ---- Shared by the scanner and the trainer: the market-cap band and the nightly sweeps
  ...[
    "MCAP_FILTER_MIN",
    "MCAP_FILTER_MAX",
    "CLEANUP_HOUR_UTC",
    "OUTCOME_TRACKING_HOUR_UTC",
    "SNAPSHOT_RETENTION_DAYS",
    "STALE_TOKEN_RETENTION_DAYS",
    "TWA_RETENTION_DAYS",
    "CANDIDATE_OUTCOME_RETENTION_DAYS",
    "CANDIDATE_OUTCOME_HIT_RETENTION_DAYS",
    "MATCH_ARCHIVE_DAYS",
    "MATCH_ARCHIVE_RETENTION_DAYS",
    "MATCH_ARCHIVE_HIT_RETENTION_DAYS",
  ].map((key): EnvVarSpec => ({
    key,
    group: "Band and retention",
    kind: "setting",
    on: WORKERS,
    same: true,
  })),
];

/** "set" with a non-blank value, "empty" when the key is there but blank, else "missing". */
export type EnvState = "set" | "empty" | "missing";

export interface EnvVarReport {
  state: EnvState;
  /** What the admin panel may show: a setting's value, a URL's origin, a secret's length. */
  hint: string | null;
  /** A secret's or URL's short SHA-256, to tell "same on every service" apart. Never sent to the browser. */
  print?: string;
}

const MAX_HINT = 80;

/** One variable's report: see the file comment for what each kind may carry. */
export function describeEnvVar(kind: EnvKind, raw: string | undefined): EnvVarReport {
  if (raw === undefined) return { state: "missing", hint: null };
  const value = raw.trim();
  if (value === "") return { state: "empty", hint: null };
  if (kind === "setting") {
    return { state: "set", hint: value.length > MAX_HINT ? `${value.slice(0, MAX_HINT - 1)}…` : value };
  }
  const print = createHash("sha256").update(value).digest("hex").slice(0, 12);
  if (kind === "url") {
    let origin: string | null = null;
    try {
      const u = new URL(value);
      origin = u.protocol === "http:" || u.protocol === "https:" ? u.host : `${u.protocol}//${u.hostname}`;
    } catch {
      // Not a URL: say nothing of it rather than echo something that may hold a key.
    }
    return { state: "set", hint: origin ?? "set, not a URL", print };
  }
  return { state: "set", hint: `${value.length} chars`, print };
}

/** Every manifest variable as this process sees it (all of them, so a stray one shows too). */
export function envReport(env: NodeJS.ProcessEnv = process.env): Record<string, EnvVarReport> {
  const out: Record<string, EnvVarReport> = {};
  for (const spec of ENV_MANIFEST) out[spec.key] = describeEnvVar(spec.kind, env[spec.key]);
  return out;
}

/** The deploy's commit, which Render sets on every service. */
export function envCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.RENDER_GIT_COMMIT?.slice(0, 12) || null;
}

/**
 * Writes this worker process's report, once at boot: Render applies an env change only by
 * restarting the service, so the boot-time report is what it runs with until the next one.
 */
export async function publishEnvReport(service: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const vars = envReport(env);
  const commit = envCommit(env);
  const reportedAt = new Date();
  await prisma.serviceEnvReport.upsert({
    where: { service },
    create: { service, vars: vars as object, commit, reportedAt },
    update: { vars: vars as object, commit, reportedAt },
  });
}

/** A stored report read back: only well-formed entries, so an odd row can't break the page. */
export function readEnvReport(vars: unknown): Record<string, EnvVarReport> {
  const out: Record<string, EnvVarReport> = {};
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) return out;
  for (const [key, v] of Object.entries(vars as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const { state, hint, print } = v as Record<string, unknown>;
    if (state !== "set" && state !== "empty" && state !== "missing") continue;
    out[key] = {
      state,
      hint: typeof hint === "string" ? hint : null,
      ...(typeof print === "string" ? { print } : {}),
    };
  }
  return out;
}
