import type { FastifyInstance } from "fastify";
import { prisma, runningSinceFrom } from "@trenchscanner/core";

/**
 * How stale a job's lastRunAt can get before we call it out - generous multiples of each job's
 * expected cadence (scan runs every few minutes, cleanup/outcome-tracking daily). Falls
 * back to 30 minutes for any job name not listed here.
 */
const STALE_THRESHOLD_MS: Record<string, number> = {
  // Runs every minute now (see SCAN_INTERVAL_MINUTES), so this is many missed cycles, not one.
  scan: 10 * 60_000,
  // Runs every minute, so a few missed passes is already a real signal - unlike the daily jobs.
  "live-price": 10 * 60_000,
  // Every FAST_MATCH_INTERVAL_SECONDS (15s by default). This is the path users actually feel -
  // while it is down alerts still arrive, but on the full cycle's minute rather than in seconds,
  // so it is worth surfacing quickly.
  "fast-match": 5 * 60_000,
  // Every few minutes. Worth surfacing promptly: while this is down, someone who burned and closed
  // the tab is locked out of what they paid for, and nothing else will notice.
  "burn-scan": 20 * 60_000,
  // Every minute, and while it's down every open training row's label window is silently
  // recording nothing - an hour of downtime is an hour of alerts whose outcomes read "flat".
  "candidate-watch": 10 * 60_000,
  // Every MATCH_PEAKS_INTERVAL_MINUTES (2 by default). Nothing time-critical waits on it -
  // peaks feed the leaderboard and outcome figures - so a generous margin.
  "match-peaks": 20 * 60_000,
  cleanup: 26 * 3_600_000,
  "outcome-tracking": 26 * 3_600_000,
  // Runs every CURATOR_TRAINING_INTERVAL_HOURS (4h by default), not daily - same "expected
  // cadence + 2h" buffer as the daily jobs above, scaled to its own interval.
  "curator-training": 6 * 3_600_000,
};
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000;
const MAX_ERROR_LENGTH = 300;

export async function registerHealthRoutes(app: FastifyInstance) {
  /** Plain liveness check - what Render's healthCheckPath hits. */
  app.get("/", async () => ({ ok: true }));

  /**
   * State of this instance's push channel. Worth surfacing because a broken LISTEN connection is
   * completely silent from the outside - no request fails, clients just quietly stop receiving
   * events and fall back to polling. Counts are per-instance, so behind multiple API instances
   * this reports whichever one answered.
   */
  app.get("/stream", async () => ({
    connected: app.matchStream.connected,
    subscribers: app.matchStream.subscriberCount,
  }));

  /**
   * Public (no auth) on purpose, like /health itself - lets an external uptime monitor or the
   * dashboard check worker health without needing a session. Error messages are truncated as a
   * light defense-in-depth measure against dumping internal detail to an unauthenticated caller.
   */
  app.get("/worker", async () => {
    const heartbeats = await prisma.systemHeartbeat.findMany({ orderBy: { job: "asc" } });
    const now = Date.now();

    return {
      jobs: heartbeats.map((h) => {
        const threshold = STALE_THRESHOLD_MS[h.job] ?? DEFAULT_STALE_THRESHOLD_MS;
        // A run in flight for longer than the stale threshold is a hung run, not a slow one -
        // reported separately because "last finished Sep 21, running since 20:33" and "last
        // finished Sep 21, nothing running" call for different fixes.
        const runningSince = runningSinceFrom(h.meta);
        const runningForMs = runningSince ? now - runningSince.getTime() : null;
        return {
          job: h.job,
          lastRunAt: h.lastRunAt,
          lastSuccessAt: h.lastSuccessAt,
          lastError: h.lastError ? h.lastError.slice(0, MAX_ERROR_LENGTH) : null,
          stale: now - h.lastRunAt.getTime() > threshold,
          runningForMs,
          hung: runningForMs !== null && runningForMs > threshold,
          // How long the last run took, and for the scan cycle where that time went - timings
          // only, nothing about tokens or users.
          lastRun: lastRunSummary(h.meta),
        };
      }),
    };
  });
}

/** The timing fields of a heartbeat's meta, and nothing else it might carry. */
function lastRunSummary(meta: unknown): { durationMs?: number; stagesMs?: Record<string, number> } | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const out: { durationMs?: number; stagesMs?: Record<string, number> } = {};
  if (typeof m.durationMs === "number") out.durationMs = m.durationMs;
  if (typeof m.stagesMs === "object" && m.stagesMs !== null && !Array.isArray(m.stagesMs)) {
    out.stagesMs = Object.fromEntries(
      Object.entries(m.stagesMs as Record<string, unknown>).filter(
        (e): e is [string, number] => typeof e[1] === "number",
      ),
    );
  }
  return Object.keys(out).length > 0 ? out : null;
}
