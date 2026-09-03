import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client. In dev, tsx/nodemon-style reloads can otherwise
 * spawn a new client (and new connection pool) per reload; stashing it on
 * globalThis avoids exhausting Postgres connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Prisma's own default `pool_timeout`, in seconds - the fallback when nothing overrides it. */
const DEFAULT_POOL_TIMEOUT_SECONDS = 20;

/**
 * Appends `connection_limit`/`pool_timeout` to a datasource URL, without disturbing anything the
 * URL already specifies.
 *
 * Pure and easy to test in isolation on purpose: this is the part that actually decides what
 * Prisma connects with, and the params it sets are exactly the two numbers a
 * "Timed out fetching a new connection from the connection pool" error names - see
 * DATABASE_CONNECTION_LIMIT and DATABASE_POOL_TIMEOUT_SECONDS in config/env.ts for why either
 * would be set. `connectionLimit` is optional: leaving it unset leaves the param unset too, so
 * Prisma falls back to its own CPU-derived default exactly as it always has - the deliberate
 * choice lives in render.yaml, not in a fallback number picked here.
 */
export function appendPoolParams(
  rawUrl: string,
  opts: { connectionLimit?: number; poolTimeoutSeconds?: number },
): string {
  const url = new URL(rawUrl);
  if (opts.connectionLimit !== undefined && !url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", String(opts.connectionLimit));
  }
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", String(opts.poolTimeoutSeconds ?? DEFAULT_POOL_TIMEOUT_SECONDS));
  }
  return url.toString();
}

/**
 * DATABASE_URL, tuned via appendPoolParams above when the environment asks for it.
 *
 * Reads `process.env` directly rather than going through `loadEnv()`: that validates the WHOLE
 * schema and throws if DATABASE_URL is missing, but this module is imported by every test file's
 * `dbAvailable` probe (`prisma.$queryRaw\`...\`.catch(() => false)`) specifically so a machine
 * with no Postgres configured at all - no DATABASE_URL in the environment - still imports cleanly
 * and fails at the QUERY, not at import. `new PrismaClient()` itself is lazy about a missing
 * DATABASE_URL for exactly that reason; going through the full schema here would have quietly
 * undone it. A missing or malformed DATABASE_URL, or a non-numeric override, therefore falls
 * through to `null`, and the caller passes no `datasourceUrl` at all - byte-for-byte the
 * original, always-lazy behaviour.
 */
function tunedDatasourceUrl(): string | null {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) return null;

  const rawLimit = process.env.DATABASE_CONNECTION_LIMIT;
  const connectionLimit = rawLimit ? Number(rawLimit) : undefined;
  const rawTimeout = process.env.DATABASE_POOL_TIMEOUT_SECONDS;
  const poolTimeoutSeconds = rawTimeout ? Number(rawTimeout) : undefined;

  try {
    return appendPoolParams(rawUrl, {
      connectionLimit: connectionLimit !== undefined && connectionLimit > 0 ? connectionLimit : undefined,
      poolTimeoutSeconds:
        poolTimeoutSeconds !== undefined && poolTimeoutSeconds > 0 ? poolTimeoutSeconds : undefined,
    });
  } catch {
    return null;
  }
}

const datasourceUrl = tunedDatasourceUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl !== null ? { datasourceUrl } : {}),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
export * from "@prisma/client";
