import {
  createLogger,
  lastSuccessfulRunAt,
  recordHeartbeat,
  recordRunStart,
  type HeartbeatJob,
} from "@trenchscanner/core";

const logger = createLogger("scheduler");

export interface ScheduledJob {
  /** Cancels the next run. A run already in flight keeps going - see `settle`. */
  stop(): void;
  /**
   * Waits for the run in flight (if any) to finish, up to `timeoutMs`. "idle": nothing was
   * running; "finished": it returned (and wrote its own heartbeat) in time; "interrupted": it is
   * still going, and the process is about to end under it.
   */
  settle(timeoutMs: number): Promise<"idle" | "finished" | "interrupted">;
}

/**
 * The message a run cut short by a shutdown leaves on its heartbeat row. Written by the worker's
 * shutdown (apps/worker/src/index.ts) for runs that outlive the grace period: a cleanup or a
 * retrain killed by a deploy used to leave no trace at all - `runningSince` stayed stamped,
 * lastSuccessAt stayed at the previous run, and nothing said the run had been cut.
 */
export const SHUTDOWN_INTERRUPTED_ERROR = "run interrupted by a worker shutdown (deploy or restart)";

/** The settle() shared by both schedulers: resolves on the in-flight run, or on the timeout. */
function settleWith(inFlight: () => Promise<void> | undefined): ScheduledJob["settle"] {
  return async (timeoutMs) => {
    const current = inFlight();
    if (!current) return "idle";
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"interrupted">((resolve) => {
      timer = setTimeout(() => resolve("interrupted"), timeoutMs);
    });
    try {
      return await Promise.race([current.then(() => "finished" as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** What a job may hand back about its own run - stored on its heartbeat row and served by
 *  GET /health/worker, which is the only view of production timing that needs no log access. */
export type JobRunMeta = Record<string, string | number | boolean | null | Record<string, number>>;

/**
 * A run still going after this many intervals is logged as stalled, and again each time that much
 * more passes. Never less than STALL_FLOOR_MS, so the 15-second fast pass is not called stalled
 * over an ordinary slow upstream minute.
 */
const STALL_INTERVALS = 5;
const STALL_FLOOR_MS = 5 * 60_000;

/** How often a run's deadline is checked - see `deadlineMinutes`. */
const DEADLINE_TICK_MS = 15_000;

/**
 * Runs `fn` immediately, then again `intervalMinutes` after each run STARTED - or straight away
 * when a run took longer than that. Runs never overlap.
 *
 * This used to be a fixed setInterval that skipped any tick landing while a run was in flight,
 * which quietly rounded every overrun up to a whole extra interval: a 70-second scan cycle on the
 * one-minute timer ran every two minutes, and an 18-second fast-match pass on its 15-second timer
 * ran every thirty. Both are on the alert path, so that rounding was added straight onto alert
 * latency. Chaining each run off the end of the previous one removes it without ever running
 * faster than the configured interval, so no upstream sees more requests than it did before - a
 * slow cycle only ever means fewer of them.
 *
 * Every run (success or failure) updates the job's heartbeat row, so GET /health/worker can tell
 * "still running, just erroring" apart from "stopped running entirely" - see
 * packages/core/src/heartbeat.ts. The row is also stamped when a run starts, so a run that never
 * returns shows up there as one running for an hour rather than as nothing at all.
 *
 * `deadlineMinutes`: a run still going after this long calls `onDeadline`, which by default exits
 * the process so the platform restarts it - see the note inside.
 */
export function scheduleInterval(
  name: HeartbeatJob,
  fn: () => Promise<JobRunMeta | void>,
  intervalMinutes: number,
  opts: {
    deadlineMinutes?: number;
    onDeadline?: (job: HeartbeatJob, runningForMs: number) => void;
    /** How long to hold the first run, in ms - by default none, it runs at once. */
    firstRunDelayMs?: () => Promise<number>;
  } = {},
): ScheduledJob {
  const intervalMs = intervalMinutes * 60_000;
  const stallMs = Math.max(STALL_FLOOR_MS, intervalMs * STALL_INTERVALS);
  const { deadlineMinutes, onDeadline = exitForRestart } = opts;
  let stopped = false;
  let next: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  const run = () => {
    inFlight = runOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const runOnce = async () => {
    const startedAt = Date.now();
    // A run that hangs is otherwise invisible: the heartbeat only advances when it returns, and
    // nothing else is ever scheduled behind it.
    const watchdog = setInterval(() => {
      logger.error("job run has not returned - nothing else of this job runs until it does", {
        job: name,
        runningForMs: Date.now() - startedAt,
      });
    }, stallMs);
    watchdog.unref?.();
    // Logging a hung run was not enough: on 2026-10-04 scan, fast-match and candidate-watch all
    // hung at 05:10 on database connections that died under them and sat there for ten hours,
    // logging, while the process stayed up and so was never restarted. A run past its deadline
    // now ends the process, and Render starts a fresh one with a fresh connection pool.
    //
    // Counted in ticks of awake time, not wall clock: curator training holds the event loop for
    // minutes at a stretch, and a plain timer firing straight after that would end a run that was
    // only waiting its turn. A late tick counts for at most two ticks.
    let awakeMs = 0;
    let lastTick = startedAt;
    const deadline =
      deadlineMinutes === undefined
        ? undefined
        : setInterval(() => {
            const now = Date.now();
            awakeMs += Math.min(now - lastTick, 2 * DEADLINE_TICK_MS);
            lastTick = now;
            if (awakeMs < deadlineMinutes * 60_000) return;
            clearInterval(deadline);
            onDeadline(name, now - startedAt);
          }, DEADLINE_TICK_MS);
    deadline?.unref?.();
    try {
      await recordRunStart(name, new Date(startedAt)).catch(() => {
        // Visibility only - never worth not running the job over.
      });
      const meta = await fn();
      await recordHeartbeat(name, {
        success: true,
        meta: { ...(meta ?? {}), durationMs: Date.now() - startedAt },
      });
    } catch (err) {
      logger.error("job threw an unhandled error", { job: name, error: String(err) });
      await recordHeartbeat(name, {
        success: false,
        error: String(err),
        meta: { durationMs: Date.now() - startedAt },
      }).catch(() => {
        // If the DB itself is unreachable, the heartbeat write will fail too - nothing more we
        // can do here, the original error is already logged above.
      });
    } finally {
      clearInterval(watchdog);
      if (deadline) clearInterval(deadline);
      const elapsed = Date.now() - startedAt;
      if (elapsed > intervalMs) {
        logger.warn("run took longer than its interval, starting the next one now", {
          job: name,
          durationMs: elapsed,
          intervalMs,
        });
      }
      if (!stopped) next = setTimeout(() => void run(), Math.max(0, intervalMs - elapsed));
    }
  };

  if (opts.firstRunDelayMs) {
    void opts
      .firstRunDelayMs()
      // The read failed (a database blip at boot): hold the first run for a whole interval rather
      // than run it at once - "at once" is exactly what the caller asked not to happen.
      .catch(() => intervalMs)
      .then((delay) => {
        if (!stopped) next = setTimeout(() => void run(), Math.max(0, delay));
      });
  } else {
    void run();
  }
  return {
    stop: () => {
      stopped = true;
      if (next) clearTimeout(next);
    },
    settle: settleWith(() => inFlight),
  };
}

/**
 * Runs `fn` once daily at `hourUtc:00 UTC`.
 *
 * The next run is scheduled when the previous one RETURNS, for the next `hourUtc` slot after
 * that - so a run that overruns a day skips to the following slot instead of stacking, and a run
 * that never returns is visible (runningSince on the heartbeat, a logged stall) instead of quietly
 * meaning the job never runs again, which is how outcome-tracking went from 2026-09-03 to
 * 2026-10-03 without completing.
 *
 * `catchUpAfterHours`: on startup, if the job's last successful run is older than this (or it has
 * never succeeded), run it now rather than waiting for the next slot. A daily job only ever fired when
 * the worker happened to be up at that hour, so a worker restarting more often than daily - an
 * out-of-memory loop, a run of deploys - could go weeks without cleanup at all.
 *
 * A run that throws is retried after `retryAfterMinutes` (default 30), up to
 * `maxRetries` (default 3) times before falling back to the next daily slot. Without that, a
 * database blip partway through cost the whole day: on 2026-10-04 production's database dropped
 * out twice within ten minutes, and both catch-up runs died with it.
 */
export function scheduleDailyAt(
  name: HeartbeatJob,
  fn: () => Promise<JobRunMeta | void>,
  hourUtc: number,
  opts: {
    catchUpAfterHours?: number;
    lastRunAt?: (job: HeartbeatJob) => Promise<Date | null>;
    retryAfterMinutes?: number;
    maxRetries?: number;
  } = {},
): ScheduledJob {
  const { retryAfterMinutes = 30, maxRetries = 3 } = opts;
  let stopped = false;
  let next: NodeJS.Timeout | undefined;
  let readRetry: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<void> | undefined;
  /** When this process last started a run - the slot it took, whatever the heartbeat row says. */
  let lastStartedAt: number | undefined;
  let failuresInARow = 0;

  const scheduleNext = () => {
    if (stopped) return;
    const untilSlot = msUntilNextHour(hourUtc);
    const retryMs = retryAfterMinutes * 60_000;
    if (failuresInARow > 0 && failuresInARow <= maxRetries && retryMs < untilSlot) {
      logger.info("daily job failed, retrying", { job: name, attempt: failuresInARow, retryAfterMinutes });
      next = setTimeout(() => void run(), retryMs);
      return;
    }
    failuresInARow = 0;
    const delay = untilSlot;
    logger.info("daily job scheduled", { job: name, hourUtc, nextRunInMinutes: Math.round(delay / 60_000) });
    next = setTimeout(() => void run(), delay);
  };

  const run = () => {
    inFlight = runOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const runOnce = async () => {
    running = true;
    const startedAt = Date.now();
    lastStartedAt = startedAt;
    const watchdog = setInterval(() => {
      logger.error("daily job run has not returned", { job: name, runningForMs: Date.now() - startedAt });
    }, DAILY_STALL_MS);
    watchdog.unref?.();
    try {
      await recordRunStart(name, new Date(startedAt)).catch(() => {});
      let meta: JobRunMeta | void;
      try {
        meta = await fn();
      } catch (err) {
        // Only the job itself failing earns a retry - not the heartbeat write after a good run.
        failuresInARow += 1;
        throw err;
      }
      failuresInARow = 0;
      await recordHeartbeat(name, {
        success: true,
        meta: { ...(meta ?? {}), durationMs: Date.now() - startedAt },
      });
    } catch (err) {
      logger.error("job threw an unhandled error", { job: name, error: String(err) });
      await recordHeartbeat(name, {
        success: false,
        error: String(err),
        meta: { durationMs: Date.now() - startedAt },
      }).catch(() => {});
    } finally {
      clearInterval(watchdog);
      running = false;
      scheduleNext();
    }
  };

  const start = async () => {
    const { catchUpAfterHours, lastRunAt = lastSuccessfulRunAt } = opts;
    if (catchUpAfterHours !== undefined) {
      const last = await lastRunAt(name).catch(() => undefined);
      if (stopped) return;
      // undefined = the read failed: don't guess. Keep the ordinary slot, and ask again shortly -
      // a worker that boots while the database is down would otherwise never catch up. Only
      // asking again used to leave no slot at all: a boot at 03:50 whose read failed asked again
      // at 04:20, found the last run under a day old, and skipped straight to tomorrow.
      if (last === undefined) {
        if (!next) scheduleNext();
        readRetry = setTimeout(() => void start(), retryAfterMinutes * 60_000);
        return;
      }
      // Overdue: never succeeded, older than the grace, or - whatever its age - from before the
      // most recent slot that has already come round. The grace alone missed a run cut short by
      // a deploy: cleanup (half an hour on 2026-10-05) killed at 04:20 left yesterday's success
      // 24h20m old, under the 26h grace, so the boot right after skipped straight to tomorrow
      // and that day's deletes never happened. A run that finished after the slot is that slot's.
      const slot = mostRecentSlot(hourUtc);
      if (
        last === null ||
        Date.now() - last.getTime() > catchUpAfterHours * 3_600_000 ||
        last.getTime() < slot
      ) {
        // The slot's own run may already be under way, or done (a late answer to a retried read
        // that still says yesterday: the row was read before this process's slot run wrote it).
        // Either way its own finally schedules the slot after.
        if (running || (lastStartedAt !== undefined && lastStartedAt >= slot)) return;
        logger.info("daily job overdue, running now", { job: name, lastSuccessAt: last });
        if (next) clearTimeout(next);
        next = undefined;
        void run();
        return;
      }
    }
    if (!next) scheduleNext();
  };
  void start();

  return {
    stop: () => {
      stopped = true;
      if (next) clearTimeout(next);
      if (readRetry) clearTimeout(readRetry);
    },
    settle: settleWith(() => inFlight),
  };
}

/** How long the deadline exit waits for its heartbeat write before giving up on it. */
const EXIT_HEARTBEAT_TIMEOUT_MS = 5_000;

/**
 * The default deadline action: a run that will never return has wedged this process for good.
 * Best effort, the failure is written to the job's heartbeat first: without it the only record
 * of "the scan passed its deadline and the worker restarted" was the log, and GET /health/worker
 * showed the previous run's (possibly clean) result under a runningSince the next process
 * overwrote within a minute.
 */
function exitForRestart(job: HeartbeatJob, runningForMs: number): void {
  logger.error("job run passed its deadline - exiting so the worker restarts", { job, runningForMs });
  const exit = () => process.exit(1);
  const giveUp = setTimeout(exit, EXIT_HEARTBEAT_TIMEOUT_MS);
  giveUp.unref?.();
  void recordHeartbeat(job, {
    success: false,
    error: `run passed its deadline after ${Math.round(runningForMs / 1000)}s; worker restarted`,
    meta: { durationMs: runningForMs },
  })
    .catch(() => {})
    .finally(exit);
}

/** A daily run going this long is logged as stalled, and again each time this much more passes. */
const DAILY_STALL_MS = 2 * 3_600_000;

/** The latest `hourUtc:00 UTC` at or before now, as a timestamp. */
function mostRecentSlot(hourUtc: number): number {
  const now = new Date();
  const slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0);
  return slot <= now.getTime() ? slot : slot - 86_400_000;
}

function msUntilNextHour(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}
