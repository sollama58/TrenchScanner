import { createLogger, recordHeartbeat, type HeartbeatJob } from "@trenchscanner/core";

const logger = createLogger("scheduler");

export interface ScheduledJob {
  stop(): void;
}

/**
 * Runs `fn` immediately, then every `intervalMinutes`. Guards against
 * overlapping runs - if a cycle is still in flight when the next tick
 * fires, that tick is skipped rather than piling up concurrent scans.
 *
 * Every run (success or failure) updates the job's heartbeat row, so
 * GET /health/worker can tell "still running, just erroring" apart from
 * "stopped running entirely" - see packages/core/src/heartbeat.ts.
 */
export function scheduleInterval(
  name: HeartbeatJob,
  fn: () => Promise<void>,
  intervalMinutes: number,
): ScheduledJob {
  let running = false;

  const tick = async () => {
    if (running) {
      logger.warn("previous run still in progress, skipping this tick", { job: name });
      return;
    }
    running = true;
    try {
      await fn();
      await recordHeartbeat(name, { success: true });
    } catch (err) {
      logger.error("job threw an unhandled error", { job: name, error: String(err) });
      await recordHeartbeat(name, { success: false, error: String(err) }).catch(() => {
        // If the DB itself is unreachable, the heartbeat write will fail too - nothing more we
        // can do here, the original error is already logged above.
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(tick, intervalMinutes * 60_000);
  return { stop: () => clearInterval(handle) };
}

/** Runs `fn` once daily at `hourUtc:00 UTC`, then every 24h from that point on. */
export function scheduleDailyAt(name: HeartbeatJob, fn: () => Promise<void>, hourUtc: number): ScheduledJob {
  const msUntilNext = msUntilNextHour(hourUtc);
  logger.info("daily job scheduled", {
    job: name,
    hourUtc,
    firstRunInMinutes: Math.round(msUntilNext / 60_000),
  });

  const timeout = setTimeout(async () => {
    await runSafely(name, fn);
    interval = setInterval(() => void runSafely(name, fn), 24 * 3_600_000);
  }, msUntilNext);

  let interval: NodeJS.Timeout | undefined;
  return {
    stop: () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    },
  };
}

async function runSafely(name: HeartbeatJob, fn: () => Promise<void>) {
  try {
    await fn();
    await recordHeartbeat(name, { success: true });
  } catch (err) {
    logger.error("job threw an unhandled error", { job: name, error: String(err) });
    await recordHeartbeat(name, { success: false, error: String(err) }).catch(() => {});
  }
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
