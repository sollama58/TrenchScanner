import { Client } from "pg";
import { createLogger, type HeartbeatJob } from "@trenchscanner/core";
import { JobSkipped } from "./scheduler.js";

const logger = createLogger("job-lock");

/** What a lock's connection calls itself in pg_stat_activity. */
export const JOB_LOCK_APPLICATION_NAME = "trenchscanner-job-lock";

/** How long taking (or letting go of) a lock may take before the attempt is abandoned. */
const LOCK_TIMEOUT_MS = 10_000;

/** The advisory-lock key text for a job - hashed by Postgres, like the repo's other locks. */
export function jobLockKey(job: HeartbeatJob): string {
  return `job-run:${job}`;
}

/**
 * Runs `fn` only while this process holds `job`'s lock, so one run of the job happens at a time
 * across every worker process. A deploy starts the new worker before the old one is stopped, and
 * both used to run the batch jobs side by side: the nightly cleanup's sweeps twice over, outcome
 * tracking's catch-up twice, and the AI judge ingesting the same finished replay batch twice -
 * its verdicts re-inserted and its cost charged to the day's budget twice. When another process
 * holds it, the run is skipped (JobSkipped): the scheduler logs it and leaves the heartbeat row to
 * the run that holds it.
 *
 * A session-level pg_try_advisory_lock on a connection of its own, not one of Prisma's: a session
 * lock belongs to the connection that took it and must be released on that same connection, which
 * a pooled client never promises - and a transaction-scoped lock would mean holding a transaction
 * open for the whole of a half-hour sweep. Ending the connection releases the lock, so there is no
 * unlock to get wrong; a connection the database drops mid-run takes the lock with it (logged),
 * and the run carries on unguarded rather than being abandoned half-way.
 */
export async function withJobLock<T>(
  job: HeartbeatJob,
  fn: () => Promise<T>,
  opts: { databaseUrl?: string } = {},
): Promise<T> {
  const client = new Client({
    connectionString: opts.databaseUrl ?? process.env.DATABASE_URL,
    connectionTimeoutMillis: LOCK_TIMEOUT_MS,
    query_timeout: LOCK_TIMEOUT_MS,
    // An idle connection held for the whole run: let the OS notice one that died under it.
    keepAlive: true,
    application_name: JOB_LOCK_APPLICATION_NAME,
  });
  // Without a listener an error on the idle connection would be thrown as an uncaught exception.
  client.on("error", (err) => {
    logger.warn("job lock connection lost - the run continues without the lock", {
      job,
      error: String(err),
    });
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [jobLockKey(job)],
    );
    if (!rows[0]?.locked) throw new JobSkipped(`another process holds the ${job} lock`);
    return await fn();
  } finally {
    // Bounded: ending a connection whose socket died can wait on it.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      client.end().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LOCK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
