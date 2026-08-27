import type { FastifyInstance } from "fastify";
import { prisma } from "@trenchscanner/core";

/**
 * How stale a job's lastRunAt can get before we call it out - generous multiples of each job's
 * expected cadence (scan runs every few minutes, digest/cleanup/outcome-tracking daily). Falls
 * back to 30 minutes for any job name not listed here.
 */
const STALE_THRESHOLD_MS: Record<string, number> = {
  // Runs every minute now (see SCAN_INTERVAL_MINUTES), so this is many missed cycles, not one.
  scan: 10 * 60_000,
  // Runs every minute, so a few missed passes is already a real signal - unlike the daily jobs.
  "live-price": 10 * 60_000,
  digest: 26 * 3_600_000,
  cleanup: 26 * 3_600_000,
  "outcome-tracking": 26 * 3_600_000,
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
      jobs: heartbeats.map((h) => ({
        job: h.job,
        lastRunAt: h.lastRunAt,
        lastSuccessAt: h.lastSuccessAt,
        lastError: h.lastError ? h.lastError.slice(0, MAX_ERROR_LENGTH) : null,
        stale: now - h.lastRunAt.getTime() > (STALE_THRESHOLD_MS[h.job] ?? DEFAULT_STALE_THRESHOLD_MS),
      })),
    };
  });
}
