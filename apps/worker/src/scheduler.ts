import { createLogger } from "@trenchscanner/core";

const logger = createLogger("scheduler");

export interface ScheduledJob {
  stop(): void;
}

/**
 * Runs `fn` immediately, then every `intervalMinutes`. Guards against
 * overlapping runs - if a cycle is still in flight when the next tick
 * fires, that tick is skipped rather than piling up concurrent scans.
 */
export function scheduleInterval(
  name: string,
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
    } catch (err) {
      logger.error("job threw an unhandled error", { job: name, error: String(err) });
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(tick, intervalMinutes * 60_000);
  return { stop: () => clearInterval(handle) };
}

/** Runs `fn` once daily at `hourUtc:00 UTC`, then every 24h from that point on. */
export function scheduleDailyAt(name: string, fn: () => Promise<void>, hourUtc: number): ScheduledJob {
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

async function runSafely(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    logger.error("job threw an unhandled error", { job: name, error: String(err) });
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
