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
 * How long one query may go without an answer before Prisma gives up on its connection.
 *
 * Prisma sets no socket timeout of its own, so a query in flight when the database went away
 * without closing the socket (a crash or restart of the host rather than of the postgres process)
 * waits forever. On 2026-10-04 that froze the worker's scan, fast-match and candidate-watch jobs
 * for ten hours after the 256MB database restarted under them. Past this, the query fails, the
 * connection is dropped, and the pool opens a fresh one on the next query.
 */
const DEFAULT_SOCKET_TIMEOUT_SECONDS = 180;

/**
 * The server-side counterpart: Postgres cancels a statement running longer than this. Shorter than
 * the socket timeout so a merely slow query is cancelled by the server (freeing its memory and
 * locks) before the client walks away from it - a client-side timeout alone leaves the query
 * running. Migrations run through the Prisma CLI on the raw DATABASE_URL and are not affected.
 */
const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 150;

/**
 * What the trainer's connections call themselves in pg_stat_activity. The Telegram dispatch waits
 * for open transactions that could still commit an alert, and leaves these out: the trainer writes
 * no alerts, and its long training reads would otherwise hold every alert back.
 */
export const TRAINER_APPLICATION_NAME = "trenchscanner-trainer";

/**
 * Appends `connection_limit`/`pool_timeout` (and the socket/statement timeouts above) to a
 * datasource URL, without disturbing anything the URL already specifies.
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
  opts: {
    connectionLimit?: number;
    poolTimeoutSeconds?: number;
    socketTimeoutSeconds?: number;
    statementTimeoutSeconds?: number;
    /** Sent as application_name alongside the statement timeout (only when `options` is ours). */
    applicationName?: string;
  },
): string {
  const url = new URL(rawUrl);
  if (opts.connectionLimit !== undefined && !url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", String(opts.connectionLimit));
  }
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", String(opts.poolTimeoutSeconds ?? DEFAULT_POOL_TIMEOUT_SECONDS));
  }
  if (!url.searchParams.has("socket_timeout")) {
    url.searchParams.set(
      "socket_timeout",
      String(opts.socketTimeoutSeconds ?? DEFAULT_SOCKET_TIMEOUT_SECONDS),
    );
  }
  if (!url.searchParams.has("options")) {
    const ms = Math.round((opts.statementTimeoutSeconds ?? DEFAULT_STATEMENT_TIMEOUT_SECONDS) * 1000);
    const name = opts.applicationName && /^[\w-]+$/.test(opts.applicationName) ? opts.applicationName : null;
    url.searchParams.set(
      "options",
      `-c statement_timeout=${ms}${name ? ` -c application_name=${name}` : ""}`,
    );
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
  const positive = (raw: string | undefined) => {
    const n = raw ? Number(raw) : NaN;
    return n > 0 ? n : undefined;
  };

  try {
    return appendPoolParams(rawUrl, {
      connectionLimit: connectionLimit !== undefined && connectionLimit > 0 ? connectionLimit : undefined,
      poolTimeoutSeconds:
        poolTimeoutSeconds !== undefined && poolTimeoutSeconds > 0 ? poolTimeoutSeconds : undefined,
      socketTimeoutSeconds: positive(process.env.DATABASE_SOCKET_TIMEOUT_SECONDS),
      statementTimeoutSeconds: positive(process.env.DATABASE_STATEMENT_TIMEOUT_SECONDS),
      applicationName: process.env.WORKER_ROLE === "trainer" ? TRAINER_APPLICATION_NAME : undefined,
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

/**
 * Binds a list of numbers for a raw query as `${floatArrayParam(xs)}::text::float8[]`: one Postgres
 * array literal such as `{1.5,NULL,54321}`, sent as a single text value.
 *
 * Passing a number[] (or a string[] with NULLs) lets Prisma guess the parameter's type from the
 * first call's values and keep it for that statement on that connection. A later call of a
 * different shape is then sent in a format Postgres can't read - 22P03 "improper binary format in
 * array element N" when whole numbers and fractions swap, or 08P01 on every later call once an
 * all-NULL list went first. A plain string is always text. Non-finite values become NULL.
 */
export function floatArrayParam(values: readonly (number | null | undefined)[]): string {
  const items = values.map((n) => (typeof n === "number" && Number.isFinite(n) ? String(n) : "NULL"));
  return `{${items.join(",")}}`;
}

export type { PrismaClient } from "@prisma/client";
export * from "@prisma/client";
