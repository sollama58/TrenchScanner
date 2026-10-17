import { runningSinceFrom } from "@trenchscanner/core";
import { DEADLINE_ERROR, SHUTDOWN_INTERRUPTED_ERROR, STOPPED_ERROR } from "./scheduler.js";

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
 * boot instead. So is a run the worker ended itself - past its deadline, or stopped from the admin
 * panel: its heartbeat was stamped as a failed run just before the restart, and going by that put
 * the retry a whole interval out too.
 */
export function trainingFirstRunDelayMs(
  heartbeat: { lastRunAt: Date; lastError: string | null; meta: unknown } | null,
  intervalMs: number,
  nowMs: number,
): number {
  if (!heartbeat) return 0;
  const cutShort =
    heartbeat.lastError === SHUTDOWN_INTERRUPTED_ERROR ||
    heartbeat.lastError?.startsWith(DEADLINE_ERROR) === true ||
    heartbeat.lastError?.startsWith(STOPPED_ERROR) === true ||
    runningSinceFrom(heartbeat.meta, heartbeat.lastRunAt) !== null;
  return cutShort ? INTERRUPTED_RUN_RETRY_MS : heartbeat.lastRunAt.getTime() + intervalMs - nowMs;
}

/**
 * The first run after a boot of an hourly job that should keep its cadence across deploys:
 * the slot its last successful run set, or now when that slot has passed (or it never ran).
 * wallet-risk and kol-side-wallets each read the whole trade tape, about 75 s apiece on
 * 2026-10-17, and both re-ran on every trainer boot - twice within 24 minutes that morning.
 */
export function keepCadenceDelayMs(lastSuccessAt: Date | null, intervalMs: number, nowMs: number): number {
  if (!lastSuccessAt) return 0;
  return Math.max(0, lastSuccessAt.getTime() + intervalMs - nowMs);
}

/**
 * A job's first run placed `offsetMs` after another job's cadence, the next such slot from now:
 * kol-side-wallets runs half an hour off wallet-risk, so the two whole-tape reads stop landing on
 * the same minute (they started in the same second on every boot). With no anchor yet, now.
 */
export function offsetCadenceDelayMs(
  anchorAt: Date | null,
  intervalMs: number,
  offsetMs: number,
  nowMs: number,
): number {
  if (!anchorAt || intervalMs <= 0) return 0;
  const first = anchorAt.getTime() + offsetMs;
  if (first >= nowMs) return first - nowMs;
  const behind = nowMs - first;
  return (intervalMs - (behind % intervalMs)) % intervalMs;
}
