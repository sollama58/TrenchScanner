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
  | "free-access"
  | "fast-match"
  | "candidate-watch"
  | "curator-training"
  | "match-peaks"
  | "ai-judge"
  | "champion-refresh"
  | "model-backup"
  | "db-dump"
  | "score-weights"
  | "lighthouse-rollup"
  | "label-regrade"
  | "candle-peaks"
  | "trade-tape"
  | "wallet-risk"
  | "dev-launch-risk"
  | "kol-side-wallets"
  | "kol-wallets"
  | "telegram-dispatch"
  | "pipeline-watch"
  | "trading-bot"
  | "paper-trading";

/**
 * Which worker process runs a job. The worker is deployed as two processes (render.yaml): the
 * "scanner" owns everything on the alert path and the per-minute label grading, the "trainer"
 * owns the batch work - model training, the AI judge's learning loop and the nightly sweeps - so
 * minutes of training CPU, the training set's memory and a crashed training run never land on
 * the 30-second scan. WORKER_ROLE picks which one a process is; "all" (the default, for local
 * dev and tests) runs every job in one process as before.
 */
export type WorkerRole = "all" | "scanner" | "trainer" | "trader";
export type JobRole = Exclude<WorkerRole, "all">;

export const HEARTBEAT_JOB_ROLE: Record<HeartbeatJob, JobRole> = {
  scan: "scanner",
  "live-price": "scanner",
  "fast-match": "scanner",
  "candidate-watch": "scanner",
  "burn-scan": "scanner",
  // Beside the burn reconciler: the other job that keeps the access tables true.
  "free-access": "scanner",
  "match-peaks": "scanner",
  "telegram-dispatch": "scanner",
  // Holds the Telegram bot token and the admin wallets it notifies (the trainer has neither).
  "pipeline-watch": "scanner",
  // The trading bot runs alone in its own process: it is the only one that can open the bot's
  // wallets (kms:Decrypt), so those credentials live nowhere else, and a slow scan cycle or a
  // crashed retrain never delays a stop-loss.
  "trading-bot": "trader",
  // Paper trading holds no key and sends nothing; it reads signals as they land, beside the scan.
  "paper-trading": "scanner",
  cleanup: "trainer",
  "outcome-tracking": "trainer",
  "curator-training": "trainer",
  "ai-judge": "trainer",
  "champion-refresh": "trainer",
  "model-backup": "trainer",
  // Not a worker job: the nightly full dump runs as its own Render cron (scripts/db-backup) and
  // writes this row itself. Counted with the trainer's batch jobs so pipeline-watch tells the
  // admins when a night's dump fails or stops coming, and the admin panel lists it beside them.
  "db-dump": "trainer",
  "score-weights": "trainer",
  "lighthouse-rollup": "trainer",
  "label-regrade": "trainer",
  // Pump.fun candle reads for alerted coins, beside the re-grade that reads the same candles.
  "candle-peaks": "trainer",
  // The scanner: the service with the Helius key the tape reads with (the trainer has none).
  "trade-tape": "scanner",
  "wallet-risk": "trainer",
  // Batch SQL over the token and outcome tables, like wallet-risk.
  "dev-launch-risk": "trainer",
  // Batch SQL over the trade tape, like wallet-risk.
  "kol-side-wallets": "trainer",
  // The scanner: the service SOLANA_TRACKER_API_KEY is set on, beside the other provider keys.
  "kol-wallets": "scanner",
};

/** Whether a process in `role` schedules `job`. */
export function runsJob(role: WorkerRole, job: HeartbeatJob): boolean {
  return role === "all" || HEARTBEAT_JOB_ROLE[job] === role;
}

export interface HeartbeatResult {
  success: boolean;
  /**
   * The row's lastError. On a success it is normally absent (clearing the last error); a run that
   * succeeded with a part of it failing (the worker's PartialJobFailure) keeps one, so the row
   * says "ran, but this went wrong" without counting as a failed run.
   */
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
      lastError: result.success ? (result.error ?? null) : (result.error ?? "unknown error"),
      meta: result.meta ?? undefined,
    },
    update: {
      lastRunAt: now,
      lastSuccessAt: result.success ? now : undefined,
      lastError: result.success ? (result.error ?? null) : (result.error ?? "unknown error"),
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
 * how long it has been going. `step` is the stage under way now (training's "examining Trees, 5 of
 * 24"), so the admin panel can show where a long run has got to. Cleared with the rest of meta by
 * the end-of-run heartbeat.
 */
export async function recordRunProgress(
  job: HeartbeatJob,
  stagesMs: Record<string, number>,
  step?: string,
): Promise<void> {
  const progress =
    step === undefined
      ? { runningStagesMs: stagesMs }
      : { runningStagesMs: stagesMs, runningStep: step, runningStepAt: new Date().toISOString() };
  await prisma.$executeRaw`
    UPDATE "SystemHeartbeat"
    SET meta = COALESCE(meta, '{}'::jsonb) || ${JSON.stringify(progress)}::jsonb
    WHERE job = ${job}`;
}

/**
 * When the run in flight started, read back from a heartbeat row's meta - see recordRunStart.
 *
 * Pass the row's lastRunAt: a heartbeat written without meta (the worker marking a run
 * interrupted at shutdown) leaves the stamp behind, and a run that finished after it started
 * is not in flight. Without this, a deploy during training left "a run is going" (and Retrain now
 * refused) until the next scheduled run, hours later.
 */
export function runningSinceFrom(meta: unknown, lastRunAt?: Date | null): Date | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>).runningSince;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  return lastRunAt && lastRunAt.getTime() > at.getTime() ? null : at;
}

/** The advisory-lock key text for a job (the worker's withJobLock) - hashed by Postgres. */
export function jobLockKey(job: HeartbeatJob): string {
  return `job-run:${job}`;
}

/**
 * The jobs whose every run holds their job lock (apps/worker/src/jobLock.ts, withJobLock) for its
 * whole length, so a run in flight is one whose lock some session holds. Keep in step with the
 * withJobLock calls in apps/worker/src/index.ts.
 */
export const JOB_LOCKED_JOBS: readonly HeartbeatJob[] = [
  "ai-judge",
  "cleanup",
  "kol-side-wallets",
  "kol-wallets",
  "label-regrade",
  "outcome-tracking",
  "trade-tape",
  "wallet-risk",
  "dev-launch-risk",
];

/**
 * Which of JOB_LOCKED_JOBS have their lock held by some database session right now. A lock lives
 * on its own connection, so Postgres lets go of it the moment the process holding it dies: a run
 * whose heartbeat still says "running" with its lock free is a run that was lost (the process
 * killed without its shutdown path - out of memory, SIGKILL), not one still going. Null when the
 * read fails, so a caller can tell "no lock held" from "don't know".
 */
export async function heldJobLocks(): Promise<Set<string> | null> {
  try {
    // A bigint advisory key shows in pg_locks as classid (high 32 bits) and objid (low 32 bits)
    // with objsubid 1; hashtext's int4 widens with its sign, as pg_try_advisory_lock takes it.
    const rows = await prisma.$queryRaw<{ job: string }[]>`
      SELECT j.job
      FROM unnest(${[...JOB_LOCKED_JOBS]}::text[]) AS j(job)
      WHERE EXISTS (
        SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext('job-run:' || j.job)::bigint
      )`;
    return new Set(rows.map((r) => r.job));
  } catch {
    return null;
  }
}

/** When a job last finished a run (successfully or not), or null if it never has. */
export async function lastHeartbeatAt(job: HeartbeatJob): Promise<Date | null> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job }, select: { lastRunAt: true } });
  return row?.lastRunAt ?? null;
}

/**
 * When a job last finished a run successfully, or null if it never has. What a daily job's boot
 * catch-up goes by: lastRunAt advances on a failed run too, so a run that failed at its slot and
 * then lost its retry timers to a restart looked like a fresh run, and the day was skipped.
 */
export async function lastSuccessfulRunAt(job: HeartbeatJob): Promise<Date | null> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job }, select: { lastSuccessAt: true } });
  return row?.lastSuccessAt ?? null;
}

/**
 * When a table that `job` rebuilds was last rebuilt, for a reader showing "updated X ago": the
 * later of a row's own stamp and the job's last successful run. The wallet-risk and kol-side-wallets
 * jobs rewrite only the rows whose figures changed, so a row's computedAt is the run that last
 * changed it, not the last run; the heartbeat carries that. A missing or unreadable heartbeat
 * falls back to the row's stamp.
 */
export async function lastRebuiltAt(job: HeartbeatJob, rowStamp: Date | null): Promise<Date | null> {
  const ran = await lastSuccessfulRunAt(job).catch(() => null);
  if (!ran) return rowStamp;
  return rowStamp && rowStamp > ran ? rowStamp : ran;
}
