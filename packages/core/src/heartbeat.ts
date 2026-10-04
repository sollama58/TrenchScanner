import { Prisma, prisma } from "./db.js";

/**
 * Background jobs that report a heartbeat. Kept as a literal union (not a free string) so a
 * typo in a job name doesn't silently create an orphan row nobody ever looks at.
 */
export type HeartbeatJob =
  | "scan"
  | "cleanup"
  | "outcome-tracking"
  | "live-price"
  | "burn-scan"
  | "fast-match"
  | "candidate-watch"
  | "curator-training"
  | "match-peaks"
  | "ai-judge";

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

/**
 * Stamps `runningSince` onto a job's heartbeat row as a run begins, leaving lastRunAt alone. The
 * end-of-run recordHeartbeat replaces meta and so clears it - a row that still carries one long
 * after its job's interval is a run that has not returned, which is otherwise indistinguishable
 * from a worker that is not running at all. No row yet (a job's first-ever run) means nothing to
 * stamp, which is fine: the run's own heartbeat creates it.
 */
export async function recordRunStart(job: HeartbeatJob, at: Date = new Date()): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SystemHeartbeat"
    SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('runningSince', ${at.toISOString()}::text)
    WHERE job = ${job}`;
}

/**
 * Stamps the stages a run in flight has finished so far onto its heartbeat row, next to
 * runningSince - so a run that never returns says which stage it is stuck after, rather than only
 * how long it has been going. Cleared with the rest of meta by the end-of-run heartbeat.
 */
export async function recordRunProgress(job: HeartbeatJob, stagesMs: Record<string, number>): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SystemHeartbeat"
    SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('runningStagesMs', ${JSON.stringify(stagesMs)}::jsonb)
    WHERE job = ${job}`;
}

/** When the run in flight started, read back from a heartbeat row's meta - see recordRunStart. */
export function runningSinceFrom(meta: unknown): Date | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>).runningSince;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** When a job last finished a run (successfully or not), or null if it never has. */
export async function lastHeartbeatAt(job: HeartbeatJob): Promise<Date | null> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job }, select: { lastRunAt: true } });
  return row?.lastRunAt ?? null;
}
