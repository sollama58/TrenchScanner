import { runningSinceFrom } from "@trenchscanner/core";
import { SHUTDOWN_INTERRUPTED_ERROR } from "./scheduler.js";

/**
 * How long to settle after a boot before a training run that a restart cut short is run again:
 * Render rolls several deploys out back to back (seven within 40 minutes on 2026-10-12), and a
 * run started on the first of them would only be cut short again.
 */
export const INTERRUPTED_RUN_RETRY_MS = 15 * 60_000;

/**
 * When the first training run after a boot should start, as a delay from `nowMs`. Normally the
 * slot the last run set: its end plus the interval, so a redeploy keeps the cadence. But a run a
 * deploy cut short is not a finished run - its heartbeat says "interrupted" (a graceful shutdown)
 * or still carries the run's start with nothing after it (the process was killed) - and going by
 * it put the next run a whole interval out: the 17:08 run on 2026-10-12 was lost to a deploy four
 * minutes in, and nothing trained until 21:11. Such a run is redone INTERRUPTED_RUN_RETRY_MS after
 * boot instead.
 */
export function trainingFirstRunDelayMs(
  heartbeat: { lastRunAt: Date; lastError: string | null; meta: unknown } | null,
  intervalMs: number,
  nowMs: number,
): number {
  if (!heartbeat) return 0;
  const cutShort =
    heartbeat.lastError === SHUTDOWN_INTERRUPTED_ERROR ||
    runningSinceFrom(heartbeat.meta, heartbeat.lastRunAt) !== null;
  return cutShort ? INTERRUPTED_RUN_RETRY_MS : heartbeat.lastRunAt.getTime() + intervalMs - nowMs;
}
