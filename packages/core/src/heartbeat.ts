import { Prisma, prisma } from "./db.js";

/**
 * Background jobs that report a heartbeat. Kept as a literal union (not a free string) so a
 * typo in a job name doesn't silently create an orphan row nobody ever looks at.
 */
export type HeartbeatJob = "scan" | "digest" | "cleanup" | "outcome-tracking" | "discovery-secondary";

export interface HeartbeatResult {
  success: boolean;
  error?: string;
  meta?: Prisma.InputJsonValue;
}

/**
 * Upserts a job's heartbeat row. Called once per run by the scheduler (see
 * apps/worker/src/scheduler.ts), regardless of whether the run succeeded - `lastRunAt` always
 * advances, `lastSuccessAt`/`lastError` reflect the latest outcome. This is what lets
 * GET /health/worker (and the dashboard) tell "still running, just failing" apart from "stopped
 * running entirely".
 */
export async function recordHeartbeat(job: HeartbeatJob, result: HeartbeatResult): Promise<void> {
  const now = new Date();
  await prisma.systemHeartbeat.upsert({
    where: { job },
    create: {
      job,
      lastRunAt: now,
      lastSuccessAt: result.success ? now : null,
      lastError: result.success ? null : (result.error ?? "unknown error"),
      meta: result.meta ?? undefined,
    },
    update: {
      lastRunAt: now,
      lastSuccessAt: result.success ? now : undefined,
      lastError: result.success ? null : (result.error ?? "unknown error"),
      meta: result.meta ?? undefined,
    },
  });
}
