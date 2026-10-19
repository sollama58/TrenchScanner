import {
  createLogger,
  JOB_LOCKED_JOBS,
  lastSuccessfulRunAt,
  recordHeartbeat,
  recordRunStart,
  type HeartbeatJob,
  withApiFeature,
} from "@trenchscanner/core";
import { exitForRestart } from "./processExit.js";

const logger = createLogger("scheduler");

/** Runs in flight in this process, by job, with when each started - for the event-loop watch. */
const inFlightRuns = new Map<HeartbeatJob, number>();

/** The jobs running right now and for how long, e.g. { scan: 4210 } - what a stall line names. */
export function runningJobsNow(now: number = Date.now()): Record<string, number> {
  return Object.fromEntries([...inFlightRuns].map(([job, startedAt]) => [job, now - startedAt]));
}

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

/**
 * Thrown by a job whose run worked but found something wrong it should report: the run is
 * recorded as failed with this message, and `meta` is kept on the heartbeat like a success's.
 */
export class JobFailure extends Error {
  constructor(
    message: string,
    readonly meta: JobRunMeta,
  ) {
    super(message);
  }
}

/**
 * Thrown by a job whose run did its work but some independent part of it failed (a cleanup stage
 * that timed out while the other sweeps ran): recorded as a SUCCESS - lastSuccessAt advances, so
 * neither the daily retries nor the next boot's catch-up re-run the whole job for one part - with
 * this message kept as the row's lastError, so GET /health/worker and the admin panel still show
 * it until a clean run clears it. `meta` is kept like a success's.
 */
export class PartialJobFailure extends Error {
  constructor(
    message: string,
    readonly meta: JobRunMeta,
  ) {
    super(message);
  }
}

/**
 * Thrown by a job that did not run because another worker process is running it right now (see
 * jobLock.ts) - two processes side by side during a deploy. Nothing is written to the heartbeat
 * row: it is the other process's run that row describes, and it records its own outcome.
 */
export class JobSkipped extends Error {}

/** What a job may hand back about its own run - stored on its heartbeat row and served by
 *  GET /health/worker, which is the only view of production timing that needs no log access. */
export type JobRunMeta = Record<
  string,
  string | number | boolean | null | Record<string, string | number | boolean | null>
>;

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
 * Calls `onDeadline` once a run has been going `deadlineMinutes`, and returns the timer to clear
 * when it ends.
 *
 * Counted in ticks of awake time, not wall clock: curator training holds the event loop for
 * minutes at a stretch, and a plain timer firing straight after that would end a run that was
 * only waiting its turn. A late tick counts for at most two ticks.
 */
function startDeadline(
  startedAt: number,
  deadlineMinutes: number | undefined,
  onDeadline: (runningForMs: number) => void,
): NodeJS.Timeout | undefined {
  if (deadlineMinutes === undefined) return undefined;
  let awakeMs = 0;
  let lastTick = startedAt;
  const timer: NodeJS.Timeout = setInterval(() => {
    const now = Date.now();
    awakeMs += Math.min(now - lastTick, 2 * DEADLINE_TICK_MS);
    lastTick = now;
    if (awakeMs < deadlineMinutes * 60_000) return;
    clearInterval(timer);
    onDeadline(now - startedAt);
  }, DEADLINE_TICK_MS);
  timer.unref?.();
  return timer;
}

/**
 * The jobs whose run start is stamped by withJobLock (jobLock.ts) once the lock is taken, rather
 * than by the scheduler before the run: a run skipped because another process holds the lock
 * stamped runningSince over the real run's, so a run hung since 03:00 read as one started at the
 * deploy, and the hung timers on /health/worker and pipeline-watch started again from there.
 */
const STAMPED_UNDER_LOCK = new Set<HeartbeatJob>(JOB_LOCKED_JOBS);

/** Stamps a run's start unless its job lock stamps it - see STAMPED_UNDER_LOCK. */
async function stampRunStart(name: HeartbeatJob, startedAt: number): Promise<void> {
  if (STAMPED_UNDER_LOCK.has(name)) return;
  // Visibility only - never worth not running the job over.
  await recordRunStart(name, new Date(startedAt)).catch(() => {});
}

/**
 * Thrown inside the scheduler when a run with `abandonOnDeadline` passes its deadline: the run is
 * recorded as failed and the next one scheduled, while the old one is left to settle on its own.
 */
class RunAbandoned extends Error {}

/**
 * Abandoned runs that have not settled yet, by job, past which a deadline restarts the worker
 * after all: a job whose every run hangs would otherwise pile up stuck calls without end.
 */
const MAX_ABANDONED_RUNS = 3;

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
    /**
     * At the deadline, give the run up rather than restart the worker: the failure is recorded,
     * the next run is scheduled, and the old run is left to settle (its result dropped). For a
     * small side job (a price sample, the holder scan) whose hang should not cost the scanner its
     * in-memory tape and caches. Past MAX_ABANDONED_RUNS unsettled, the deadline restarts as usual.
     */
    abandonOnDeadline?: boolean;
    /** How long to hold the first run, in ms - by default none, it runs at once. */
    firstRunDelayMs?: () => Promise<number>;
    /** Meta a failed run still records (a run that throws otherwise leaves only its timing). */
    failureMeta?: () => JobRunMeta;
    /**
     * Checked every `everyMs` while the job waits for its next slot: true starts the run now and
     * the cadence restarts from it (an admin's "retrain now"). Never while a run is in flight.
     */
    runEarly?: {
      everyMs: number;
      due: () => Promise<boolean>;
      /** Don't log each early run: for a job woken by routine events rather than a person. */
      quiet?: boolean;
    };
    /**
     * Checked every `everyMs` while a run is in flight: true ends the run the way a deadline does
     * (heartbeat says so, then the worker restarts) - an admin's "Stop and retrain" on a run that
     * looks stuck. Polled from the event loop, so it reaches a run waiting on I/O or on its
     * training thread, as the deadline does.
     */
    stopWhileRunning?: {
      everyMs: number;
      due: () => Promise<boolean>;
      onStop?: (job: HeartbeatJob, runningForMs: number) => void;
    };
  } = {},
): ScheduledJob {
  const intervalMs = intervalMinutes * 60_000;
  const stallMs = Math.max(STALL_FLOOR_MS, intervalMs * STALL_INTERVALS);
  const { deadlineMinutes, onDeadline = exitOnDeadline } = opts;
  /** Runs given up at their deadline (abandonOnDeadline) that have not settled yet. */
  let abandoned = 0;
  let stopped = false;
  let next: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;

  const run = () => {
    if (inFlight) return inFlight;
    started = true;
    inFlight = runOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const runOnce = async () => {
    const startedAt = Date.now();
    inFlightRuns.set(name, startedAt);
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
    // now ends the process, and Render starts a fresh one with a fresh connection pool - or, for
    // a job that asks for it, is given up so the next run can start (abandonOnDeadline).
    let abandon: ((err: RunAbandoned) => void) | undefined;
    const abandonedRun = new Promise<never>((_, reject) => {
      abandon = reject;
    });
    abandonedRun.catch(() => {});
    const deadline = startDeadline(startedAt, deadlineMinutes, (runningForMs) => {
      if (opts.abandonOnDeadline && abandoned < MAX_ABANDONED_RUNS) {
        abandon?.(
          new RunAbandoned(`${DEADLINE_ERROR} after ${Math.round(runningForMs / 1000)}s; run abandoned`),
        );
        return;
      }
      onDeadline(name, runningForMs);
    });
    const stopper = opts.stopWhileRunning;
    let stopping = false;
    let checkingStop = false;
    const stopCheck =
      stopper === undefined
        ? undefined
        : setInterval(() => {
            if (stopping || checkingStop) return;
            checkingStop = true;
            void stopper
              .due()
              .catch(() => false)
              .then((due) => {
                if (!due || stopping) return;
                stopping = true;
                clearInterval(stopCheck);
                (stopper.onStop ?? exitOnStopRequest)(name, Date.now() - startedAt);
              })
              .finally(() => {
                checkingStop = false;
              });
          }, stopper.everyMs);
    stopCheck?.unref?.();
    try {
      await stampRunStart(name, startedAt);
      // Every outside call the run makes is counted under the job's name (core's apiUsage.ts).
      const running = withApiFeature(name, fn);
      const meta = await Promise.race([running, abandonedRun]).catch((err: unknown) => {
        if (err instanceof RunAbandoned) {
          // Left to settle on its own; counted until it does, so a job that only ever hangs ends
          // up restarting the worker after all.
          abandoned += 1;
          void running
            .catch(() => {})
            .finally(() => {
              abandoned -= 1;
            });
          logger.error("job run passed its deadline - abandoned, the next run is scheduled", {
            job: name,
            runningForMs: Date.now() - startedAt,
            unsettled: abandoned,
          });
        }
        throw err;
      });
      // The effective cadence rides on the row: the intervals are env-tunable, so /health/worker
      // derives its stale threshold from this rather than a table that drifts from the env.
      await recordHeartbeat(name, {
        success: true,
        meta: { ...(meta ?? {}), durationMs: Date.now() - startedAt, intervalMs },
      });
    } catch (err) {
      if (err instanceof JobSkipped) {
        logger.info("run skipped - another process is running this job", { job: name, reason: err.message });
        return;
      }
      if (err instanceof PartialJobFailure) {
        await recordHeartbeat(name, {
          success: true,
          error: err.message,
          meta: { ...err.meta, durationMs: Date.now() - startedAt, intervalMs },
        }).catch(() => {});
        return;
      }
      if (!(err instanceof RunAbandoned)) {
        logger.error("job threw an unhandled error", { job: name, error: String(err) });
      }
      // A job that fails on purpose (pipeline-watch flagging a stall) keeps its counts on the row.
      const errMeta = { ...opts.failureMeta?.(), ...(err instanceof JobFailure ? err.meta : {}) };
      await recordHeartbeat(name, {
        success: false,
        error: err instanceof JobFailure || err instanceof RunAbandoned ? err.message : String(err),
        meta: { ...errMeta, durationMs: Date.now() - startedAt, intervalMs },
      }).catch(() => {
        // If the DB itself is unreachable, the heartbeat write will fail too - nothing more we
        // can do here, the original error is already logged above.
      });
    } finally {
      clearInterval(watchdog);
      inFlightRuns.delete(name);
      if (deadline) clearInterval(deadline);
      if (stopCheck) clearInterval(stopCheck);
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

  // Whether any run has started: an early run (runEarly) can beat the first run's delay, and its
  // own successor is then the cadence - the delayed first run must not start a second one.
  let checkingEarly = false;
  const early =
    opts.runEarly === undefined
      ? undefined
      : setInterval(() => {
          if (stopped || inFlight || checkingEarly) return;
          checkingEarly = true;
          void opts
            .runEarly!.due()
            .catch(() => false)
            .then((due) => {
              if (!due || stopped || inFlight) return;
              if (next) clearTimeout(next);
              if (!opts.runEarly!.quiet) logger.info("running early on request", { job: name });
              void run();
            })
            .finally(() => {
              checkingEarly = false;
            });
        }, opts.runEarly.everyMs);
  early?.unref?.();

  if (opts.firstRunDelayMs) {
    void opts
      .firstRunDelayMs()
      // The read failed (a database blip at boot): hold the first run for a whole interval rather
      // than run it at once - "at once" is exactly what the caller asked not to happen.
      .catch(() => intervalMs)
      .then((delay) => {
        if (!stopped && !started) next = setTimeout(() => void run(), Math.max(0, delay));
      });
  } else {
    void run();
  }
  return {
    stop: () => {
      stopped = true;
      if (next) clearTimeout(next);
      if (early) clearInterval(early);
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
    /**
     * Checked every `everyMs` while the job waits for its slot: true runs it now (an admin's "Run
     * now"), and the slot after that run is the next one as usual. Never while a run is in flight.
     */
    runEarly?: { everyMs: number; due: () => Promise<boolean> };
    /**
     * A run still going after this long restarts the worker, as an interval job's deadline does
     * (scheduleInterval): a nightly run hung on a dead connection otherwise held its job until the
     * next deploy, and the boot after it catches the slot up.
     */
    deadlineMinutes?: number;
    onDeadline?: (job: HeartbeatJob, runningForMs: number) => void;
  } = {},
): ScheduledJob {
  const { retryAfterMinutes = 30, maxRetries = 3, deadlineMinutes, onDeadline = exitOnDeadline } = opts;
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
    // Only ever one slot pending: an early run can finish while start() is still settling the
    // first one, and both would otherwise leave a timer.
    if (next) clearTimeout(next);
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

  /**
   * After a run skipped because another process holds the job (a deploy's old and new worker side
   * by side), the slot is asked about again later rather than given up: the other run may be the
   * old process's, cut short by that same deploy, and only the heartbeat row says whether it
   * finished. start() re-reads it - a slot already done just waits for the next one.
   */
  const recheckAfterSkip = () => {
    if (stopped) return;
    next = setTimeout(() => {
      next = undefined;
      void start();
    }, retryAfterMinutes * 60_000);
  };

  const runOnce = async () => {
    running = true;
    const startedAt = Date.now();
    inFlightRuns.set(name, startedAt);
    const previousStartedAt = lastStartedAt;
    lastStartedAt = startedAt;
    let skipped = false;
    const watchdog = setInterval(() => {
      logger.error("daily job run has not returned", { job: name, runningForMs: Date.now() - startedAt });
    }, DAILY_STALL_MS);
    watchdog.unref?.();
    const deadline = startDeadline(startedAt, deadlineMinutes, (runningForMs) =>
      onDeadline(name, runningForMs),
    );
    try {
      await stampRunStart(name, startedAt);
      let meta: JobRunMeta | void;
      let partialError: string | undefined;
      try {
        meta = await withApiFeature(name, fn);
      } catch (err) {
        if (err instanceof PartialJobFailure) {
          // Recorded as a success with the error kept - see PartialJobFailure. No retry.
          meta = err.meta;
          partialError = err.message;
        } else {
          // Only the job itself failing earns a retry - not the heartbeat write after a good run.
          if (!(err instanceof JobSkipped)) failuresInARow += 1;
          throw err;
        }
      }
      failuresInARow = 0;
      // The slot rides on the row, as intervalMs does for interval jobs - see scheduleInterval.
      await recordHeartbeat(name, {
        success: true,
        ...(partialError !== undefined ? { error: partialError } : {}),
        meta: { ...(meta ?? {}), durationMs: Date.now() - startedAt, dailyAtHourUtc: hourUtc },
      });
    } catch (err) {
      if (err instanceof JobSkipped) {
        skipped = true;
        // This process did not take the slot after all - the catch-up must not think it did.
        lastStartedAt = previousStartedAt;
        failuresInARow = 0;
        logger.info("run skipped - another process is running this job", { job: name, reason: err.message });
      } else {
        logger.error("job threw an unhandled error", { job: name, error: String(err) });
        await recordHeartbeat(name, {
          success: false,
          error: String(err),
          meta: { durationMs: Date.now() - startedAt, dailyAtHourUtc: hourUtc },
        }).catch(() => {});
      }
    } finally {
      clearInterval(watchdog);
      if (deadline) clearInterval(deadline);
      inFlightRuns.delete(name);
      running = false;
      if (skipped) recheckAfterSkip();
      else scheduleNext();
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

  let checkingEarly = false;
  const early =
    opts.runEarly === undefined
      ? undefined
      : setInterval(() => {
          if (stopped || running || checkingEarly) return;
          checkingEarly = true;
          void opts
            .runEarly!.due()
            .catch(() => false)
            .then((due) => {
              if (!due || stopped || running) return;
              if (next) clearTimeout(next);
              next = undefined;
              logger.info("running early on request", { job: name });
              void run();
            })
            .finally(() => {
              checkingEarly = false;
            });
        }, opts.runEarly.everyMs);
  early?.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (next) clearTimeout(next);
      if (readRetry) clearTimeout(readRetry);
      if (early) clearInterval(early);
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
 *
 * Then the worker's own shutdown (processExit.ts), not a bare process.exit: the other jobs' runs
 * get the grace period to finish, and the ones that can't are marked interrupted. The hung run
 * holds none of that up - settle() gives up on it after the grace like any other run - and keeps
 * the deadline message written here rather than being re-stamped "interrupted".
 */
function exitOnDeadline(job: HeartbeatJob, runningForMs: number): void {
  logger.error("job run passed its deadline - exiting so the worker restarts", { job, runningForMs });
  endRunAndRestart(
    job,
    runningForMs,
    `${DEADLINE_ERROR} after ${Math.round(runningForMs / 1000)}s; worker restarted`,
    `${job} run passed its deadline`,
  );
}

/**
 * The default stop action (stopWhileRunning): the same exit as a deadline, under its own message,
 * so the heartbeat and the panel say a person stopped the run rather than that it hung.
 */
function exitOnStopRequest(job: HeartbeatJob, runningForMs: number): void {
  logger.warn("job run stopped on request - exiting so the worker restarts", { job, runningForMs });
  endRunAndRestart(
    job,
    runningForMs,
    `${STOPPED_ERROR} after ${Math.round(runningForMs / 1000)}s; worker restarted`,
    `${job} run stopped on request`,
  );
}

/** The heartbeat error a run past its deadline leaves (followed by how long it ran). */
export const DEADLINE_ERROR = "run passed its deadline";
/** The heartbeat error a run stopped from the admin panel leaves (followed by how long it ran). */
export const STOPPED_ERROR = "run stopped from the admin panel";

/** Writes `error` to the job's heartbeat (best effort, briefly), then restarts the worker. */
function endRunAndRestart(job: HeartbeatJob, runningForMs: number, error: string, reason: string): void {
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    exitForRestart({ reason, keepHeartbeatOf: job });
  };
  const giveUp = setTimeout(exit, EXIT_HEARTBEAT_TIMEOUT_MS);
  giveUp.unref?.();
  void recordHeartbeat(job, { success: false, error, meta: { durationMs: runningForMs } })
    .catch(() => {})
    .finally(() => {
      clearTimeout(giveUp);
      exit();
    });
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
