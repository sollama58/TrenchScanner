import {
  createLogger,
  lastHeartbeatAt,
  recordHeartbeat,
  recordRunStart,
  type HeartbeatJob,
} from "@trenchscanner/core";

const logger = createLogger("scheduler");

export interface ScheduledJob {
  stop(): void;
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
 */
export function scheduleInterval(
  name: HeartbeatJob,
  fn: () => Promise<JobRunMeta | void>,
  intervalMinutes: number,
): ScheduledJob {
  const intervalMs = intervalMinutes * 60_000;
  const stallMs = Math.max(STALL_FLOOR_MS, intervalMs * STALL_INTERVALS);
  let stopped = false;
  let next: NodeJS.Timeout | undefined;

  const run = async () => {
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

  void run();
  return {
    stop: () => {
      stopped = true;
      if (next) clearTimeout(next);
    },
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
 * `catchUpAfterHours`: on startup, if the job's last recorded run is older than this (or it has
 * never run), run it now rather than waiting for the next slot. A daily job only ever fired when
 * the worker happened to be up at that hour, so a worker restarting more often than daily - an
 * out-of-memory loop, a run of deploys - could go weeks without cleanup at all.
 */
export function scheduleDailyAt(
  name: HeartbeatJob,
  fn: () => Promise<void>,
  hourUtc: number,
  opts: { catchUpAfterHours?: number; lastRunAt?: (job: HeartbeatJob) => Promise<Date | null> } = {},
): ScheduledJob {
  let stopped = false;
  let next: NodeJS.Timeout | undefined;

  const scheduleNext = () => {
    if (stopped) return;
    const delay = msUntilNextHour(hourUtc);
    logger.info("daily job scheduled", { job: name, hourUtc, nextRunInMinutes: Math.round(delay / 60_000) });
    next = setTimeout(() => void run(), delay);
  };

  const run = async () => {
    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      logger.error("daily job run has not returned", { job: name, runningForMs: Date.now() - startedAt });
    }, DAILY_STALL_MS);
    watchdog.unref?.();
    try {
      await recordRunStart(name, new Date(startedAt)).catch(() => {});
      await fn();
      await recordHeartbeat(name, { success: true, meta: { durationMs: Date.now() - startedAt } });
    } catch (err) {
      logger.error("job threw an unhandled error", { job: name, error: String(err) });
      await recordHeartbeat(name, {
        success: false,
        error: String(err),
        meta: { durationMs: Date.now() - startedAt },
      }).catch(() => {});
    } finally {
      clearInterval(watchdog);
      scheduleNext();
    }
  };

  const start = async () => {
    const { catchUpAfterHours, lastRunAt = lastHeartbeatAt } = opts;
    if (catchUpAfterHours !== undefined) {
      const last = await lastRunAt(name).catch(() => undefined);
      // undefined = the read failed: don't guess, keep the ordinary schedule.
      if (
        last !== undefined &&
        (last === null || Date.now() - last.getTime() > catchUpAfterHours * 3_600_000)
      ) {
        logger.info("daily job overdue, running now", { job: name, lastRunAt: last });
        if (!stopped) void run();
        return;
      }
    }
    scheduleNext();
  };
  void start();

  return {
    stop: () => {
      stopped = true;
      if (next) clearTimeout(next);
    },
  };
}

/** A daily run going this long is logged as stalled, and again each time this much more passes. */
const DAILY_STALL_MS = 2 * 3_600_000;

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
