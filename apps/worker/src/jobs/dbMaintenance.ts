import { Client } from "pg";
import { createLogger, prisma, TRAINER_APPLICATION_NAME } from "@trenchscanner/core";

const logger = createLogger("db-maintenance");

/**
 * The indexes the weekly rebuild takes back to size: the same four as scripts/reindex-bloat.sql.
 * TokenSnapshot's two regrow about 60 MB a day on a table whose row count is flat (full audit
 * 2026-10-27, DB-3: 398 MB after the 10-14 reindex, 1,247 MB on 10-27): the nightly downsample
 * deletes rows scattered through each token's range, and a B-tree page is only recycled once it is
 * completely empty. Token's two carry the stale-token sweep's deletes the same way.
 */
export const REINDEX_TARGETS = [
  "TokenSnapshot_pkey",
  "TokenSnapshot_tokenId_takenAt_idx",
  "Token_pkey",
  "Token_mintAddress_key",
] as const;

/**
 * A rebuild builds the new index beside the old one, so it needs the index's size again in free
 * disk; it runs only while the database is at least this many times the index's size under the
 * disk warning line (DB_DISK_ALERT_MB, itself about 3 GB under the disk).
 */
export const REINDEX_HEADROOM_FACTOR = 2;
/** One rebuild's bound: the largest took about a minute at 1.2 GB; the pool's 150 s would be too tight. */
const REINDEX_STATEMENT_TIMEOUT_MS = 30 * 60_000;
/**
 * How long a rebuild waits for its table's lock before giving up (a migration, a manual VACUUM): it
 * never blocks readers or writers, so waiting is only ever on another maintenance statement.
 */
const REINDEX_LOCK_TIMEOUT_MS = 60_000;

export interface ReindexResult {
  /** `<index> <before>-><after> MB`, for each one rebuilt. */
  rebuilt: string[];
  skipped: string[];
  /** Leftovers of an earlier rebuild cut off midway (`*_ccnew`, `*_ccold`), dropped first. */
  droppedLeftovers: string[];
  freedMb: number;
}

const mb = (bytes: bigint | number) => Math.round(Number(bytes) / 1_048_576);

/** Each index's size in bytes, by name; a missing one is left out. */
async function indexSizes(names: readonly string[]): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ name: string; bytes: bigint }[]>`
    SELECT c.relname AS name, pg_relation_size(c.oid) AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'i' AND c.relname = ANY(${[...names]})`;
  return new Map(rows.map((r) => [r.name, Number(r.bytes)]));
}

/**
 * The invalid indexes of this schema, less the ones a CREATE INDEX or REINDEX is building right now.
 * A failed `CONCURRENTLY` build (a migration that timed out, a rebuild cut off by a restart) leaves
 * its index INVALID: never used by a query, still written on every insert, and a migration re-run
 * then skips it (`IF NOT EXISTS`). Nothing showed one until it was noticed by hand (DB-9).
 */
export async function findInvalidIndexes(): Promise<{ table: string; index: string }[]> {
  return prisma.$queryRaw<{ table: string; index: string }[]>`
    SELECT t.relname AS table, i.relname AS index
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema() AND NOT x.indisvalid
      AND NOT EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.relid = x.indrelid)
    ORDER BY t.relname, i.relname`;
}

/**
 * Rebuilds REINDEX_TARGETS with REINDEX CONCURRENTLY, one at a time: no lock that stops a reader or
 * a writer, the old index serving queries until the new one replaces it. The statement cannot run
 * inside a transaction and outlasts the pool's statement_timeout, so it runs on a connection of its
 * own. An index is skipped while the database is within REINDEX_HEADROOM_FACTOR x its size of the
 * disk warning line, and every one is skipped when that line is off (0): with the disk's size
 * unknown, filling it is the one way this could hurt. A rebuild that fails is reported and the rest
 * still run; the next week's tries again, after dropping what the failed one left behind.
 */
export async function reindexBloated(opts: {
  diskAlertMb: number;
  databaseUrl?: string;
  targets?: readonly string[];
}): Promise<ReindexResult> {
  const targets = opts.targets ?? REINDEX_TARGETS;
  const result: ReindexResult = { rebuilt: [], skipped: [], droppedLeftovers: [], freedMb: 0 };
  if (opts.diskAlertMb <= 0) {
    result.skipped.push(...targets.map((t) => `${t} (DB_DISK_ALERT_MB is off)`));
    return result;
  }
  const client = new Client({
    connectionString: opts.databaseUrl ?? process.env.DATABASE_URL,
    connectionTimeoutMillis: 30_000,
    keepAlive: true,
    // Writes no alert, so the Telegram dispatch's wait for open transactions leaves it out.
    application_name: TRAINER_APPLICATION_NAME,
  });
  await client.connect();
  const failures: string[] = [];
  try {
    await client.query(`SET statement_timeout = ${REINDEX_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET lock_timeout = ${REINDEX_LOCK_TIMEOUT_MS}`);
    // A rebuild cut off midway leaves an invalid `<index>_ccnew` (or `_ccold`) behind, written on
    // every insert and in the way of the next rebuild's name.
    const { rows: leftovers } = await client.query<{ name: string }>(
      `SELECT i.relname AS name FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = i.relnamespace
       WHERE n.nspname = current_schema() AND NOT x.indisvalid
         AND i.relname ~ ('^(' || array_to_string($1::text[], '|') || ')_cc(new|old)[0-9]*$')`,
      [[...targets]],
    );
    for (const { name } of leftovers) {
      try {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name.replace(/"/g, '""')}"`);
        result.droppedLeftovers.push(name);
      } catch (err) {
        failures.push(`drop ${name}: ${String(err)}`);
      }
    }

    for (const index of targets) {
      const before = (await indexSizes([index])).get(index);
      if (before === undefined) {
        result.skipped.push(`${index} (no such index)`);
        continue;
      }
      const {
        rows: [db],
      } = await client.query<{ bytes: string }>("SELECT pg_database_size(current_database()) AS bytes");
      const headroomMb = opts.diskAlertMb - mb(BigInt(db?.bytes ?? "0"));
      if (headroomMb < REINDEX_HEADROOM_FACTOR * mb(before)) {
        result.skipped.push(
          `${index} (${headroomMb} MB under the disk line, needs ${REINDEX_HEADROOM_FACTOR * mb(before)})`,
        );
        continue;
      }
      const begun = Date.now();
      try {
        await client.query(`REINDEX INDEX CONCURRENTLY "${index.replace(/"/g, '""')}"`);
      } catch (err) {
        failures.push(`${index}: ${String(err)}`);
        continue;
      }
      const after = (await indexSizes([index])).get(index) ?? before;
      result.rebuilt.push(`${index} ${mb(before)}->${mb(after)} MB`);
      result.freedMb += mb(before) - mb(after);
      logger.info("index rebuilt", {
        index,
        beforeMb: mb(before),
        afterMb: mb(after),
        ms: Date.now() - begun,
      });
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  if (failures.length > 0) {
    throw new Error(
      `reindex: ${failures.join("; ").slice(0, 400)} (rebuilt: ${result.rebuilt.join(", ") || "none"})`,
    );
  }
  return result;
}
