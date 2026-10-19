import { Client } from "pg";
import {
  createLogger,
  jobLockKey,
  recordLockLost,
  recordRunStart,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { JobSkipped } from "./scheduler.js";

const logger = createLogger("job-lock");

/** What a lock's connection calls itself in pg_stat_activity. */
export const JOB_LOCK_APPLICATION_NAME = "trenchscanner-job-lock";

/** How long taking (or letting go of) a lock may take before the attempt is abandoned. */
const LOCK_TIMEOUT_MS = 10_000;

export { jobLockKey };

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
 * unlock to get wrong.
 *
 * A connection the database drops mid-run takes the lock with it, and the run carries on rather
 * than being abandoned half-way. The lock is taken again on a fresh connection when it can be; when
 * it can't (another process took it meanwhile, or the database is still unreachable), the run is
 * marked on its heartbeat row (recordLockLost), so the lost-run check - "running, lock free" - does
 * not call a run that is still going lost.
 *
 * The run's start is stamped here, once the lock is taken (the scheduler leaves these jobs to it):
 * a skipped run's stamp used to replace the running one's.
 */
export async function withJobLock<T>(
  job: HeartbeatJob,
  fn: () => Promise<T>,
  opts: { databaseUrl?: string; startedAt?: Date } = {},
): Promise<T> {
  const connect = () =>
    new Client({
      connectionString: opts.databaseUrl ?? process.env.DATABASE_URL,
      connectionTimeoutMillis: LOCK_TIMEOUT_MS,
      query_timeout: LOCK_TIMEOUT_MS,
      // An idle connection held for the whole run: let the OS notice one that died under it.
      keepAlive: true,
      application_name: JOB_LOCK_APPLICATION_NAME,
    });
  const take = async (client: Client): Promise<boolean> => {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [jobLockKey(job)],
    );
    return rows[0]?.locked === true;
  };
  const clients: Client[] = [];
  let finished = false;
  /** Watches a lock's connection; a loss takes the lock again on a new one, or marks the run. */
  const watch = (client: Client) => {
    // Without a listener an error on the idle connection would be thrown as an uncaught exception.
    client.on("error", (err) => {
      if (finished) return;
      logger.warn("job lock connection lost - taking the lock again", { job, error: String(err) });
      void retake();
    });
  };
  let retaking = false;
  const retake = async () => {
    if (retaking) return;
    retaking = true;
    const next = connect();
    // A failure on this one is answered below, not by another retake.
    next.on("error", () => {});
    clients.push(next);
    try {
      const locked = await take(next);
      if (finished) {
        // The run ended while this was connecting: let go of what it took.
        await next.end().catch(() => {});
        return;
      }
      if (locked) {
        watch(next);
        logger.info("job lock taken again", { job });
        return;
      }
      logger.warn("job lock held elsewhere after a lost connection - the run continues without it", { job });
    } catch (err) {
      logger.warn("job lock not taken again - the run continues without it", { job, error: String(err) });
    } finally {
      retaking = false;
    }
    await recordLockLost(job).catch(() => {});
  };
  const first = connect();
  clients.push(first);
  watch(first);
  try {
    if (!(await take(first))) throw new JobSkipped(`another process holds the ${job} lock`);
    await recordRunStart(job, opts.startedAt).catch(() => {
      // Visibility only - never worth not running the job over.
    });
    return await fn();
  } finally {
    finished = true;
    // Bounded: ending a connection whose socket died can wait on it.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(clients.map((c) => c.end().catch(() => {}))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LOCK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
