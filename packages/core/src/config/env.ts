import { z } from "zod";

/**
 * Central env schema shared by the api and worker apps. Each app calls
 * `loadEnv()` once at startup; failing fast with a clear message beats a
 * confusing runtime crash three layers down.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),

  HELIUS_API_KEY: z.string().optional().default(""),
  DEXSCREENER_BASE_URL: z.string().default("https://api.dexscreener.com"),
  PUMPFUN_BASE_URL: z.string().default("https://frontend-api-v3.pump.fun"),

  SCAN_INTERVAL_MINUTES: z.coerce.number().positive().default(7),
  DIGEST_HOUR_UTC: z.coerce.number().min(0).max(23).default(13),
  MCAP_FILTER_MIN: z.coerce.number().nonnegative().default(50_000),
  MCAP_FILTER_MAX: z.coerce.number().positive().default(500_000),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),

  API_PORT: z.coerce.number().positive().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
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
  return env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
}
