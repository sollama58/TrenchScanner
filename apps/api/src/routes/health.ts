import type { FastifyInstance } from "fastify";
import {
  HEARTBEAT_JOB_ROLE,
  prisma,
  readAiBudget,
  runningSinceFrom,
  type Env,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";

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
  // Every TELEGRAM_DISPATCH_INTERVAL_SECONDS (10 by default). While it is down linked Telegram
  // chats hear nothing, and nothing else notices.
  "telegram-dispatch": 10 * 60_000,
  // Every 5 minutes: says when a stage of the alert path stops producing (pipelineWatchJob.ts).
  "pipeline-watch": 20 * 60_000,
  cleanup: 26 * 3_600_000,
  "outcome-tracking": 26 * 3_600_000,
  // Runs every CURATOR_TRAINING_INTERVAL_HOURS (2h by default), not daily - same "expected
  // cadence + 2h" buffer as the daily jobs above, scaled to its own interval.
  "curator-training": 4 * 3_600_000,
  // Every 10 minutes; replay batches and playbook rounds wait on it, nothing user-facing does.
  "ai-judge": 40 * 60_000,
  // Hourly: re-chooses the default model from the leaderboard between training runs.
  "champion-refresh": 3 * 3_600_000,
  // Hourly: takes the weekly model backup when one is due and copies new ones off-site.
  "model-backup": 3 * 3_600_000,
  // Every SCORE_WEIGHTS_INTERVAL_HOURS (6): refits the composite score's weights.
  "score-weights": 14 * 3_600_000,
  // Hourly: sums the Lighthouse's history (apps/worker/src/jobs/lighthouseRollupJob.ts).
  "lighthouse-rollup": 3 * 3_600_000,
};
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000;
/**
 * A job whose heartbeat says how often it runs (the scheduler writes `intervalMs`, see
 * apps/worker/src/scheduler.ts) is stale after this many of its own intervals - the table above
 * is only a floor for it. The intervals are env-tunable (CURATOR_TRAINING_INTERVAL_HOURS, say),
 * and a table alone drifts from them: a job set to run every six hours read as stale after four.
 */
const STALE_AFTER_INTERVALS = 3;
const MAX_ERROR_LENGTH = 300;

/**
 * How stale a job may get before /health/worker says so: the table's figure, raised to
 * STALE_AFTER_INTERVALS of the cadence the job's own heartbeat reports when it reports one.
 * A daily job's row carries `dailyAtHourUtc` instead, and the table's 26 hours already fits it.
 */
export function staleThresholdMs(job: string, meta: unknown): number {
  const table = STALE_THRESHOLD_MS[job] ?? DEFAULT_STALE_THRESHOLD_MS;
  const intervalMs = numberField(meta, "intervalMs");
  if (intervalMs === null || intervalMs <= 0) return table;
  return Math.max(table, intervalMs * STALE_AFTER_INTERVALS);
}

/** One numeric field of a heartbeat's meta, or null. */
function numberField(meta: unknown, key: string): number | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Meta fields that describe the schedule, not the run - kept out of `lastRun`. */
const SCHEDULE_META_KEYS = new Set(["intervalMs", "dailyAtHourUtc"]);

/**
 * The public shape of a job's last error: its first line, clipped, with hosts and URLs blanked.
 * Prisma's connection errors name the database host and port and upstream errors carry the URL
 * they called; this route needs no sign-in, so neither belongs in it (the admin route has the
 * full text).
 */
export function publicErrorText(error: string): string {
  return (error.split("\n")[0] ?? "")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}:\d{2,5}\b/gi, "<host>")
    .replace(/\b[a-z0-9-]+:\d{2,5}\b/gi, "<host>")
    .slice(0, MAX_ERROR_LENGTH);
}

/**
 * How long one read of the heartbeats answers /health/worker. The route is public and was a
 * database query per call, so anyone could spend the API's twelve pool connections on it at the
 * global rate limit; heartbeats move once a job finishes, so a few seconds hide nothing.
 */
const WORKER_HEALTH_CACHE_MS = 5_000;

export async function registerHealthRoutes(
  app: FastifyInstance,
  opts: { env?: Pick<Env, "AI_DAILY_BUDGET_USD" | "AI_BUDGET_REVIEW_RESERVE_PCT"> } = {},
) {
  const budgetEnv = opts.env ?? { AI_DAILY_BUDGET_USD: 10, AI_BUDGET_REVIEW_RESERVE_PCT: 40 };
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
  const readHeartbeats = async () => {
    const [heartbeats, aiBudget] = await Promise.all([
      prisma.systemHeartbeat.findMany({ orderBy: { job: "asc" } }),
      readAiBudget(budgetEnv),
    ]);
    return { heartbeats, aiBudget };
  };
  const heartbeatCache = new SharedCache<Awaited<ReturnType<typeof readHeartbeats>>>(WORKER_HEALTH_CACHE_MS);

  app.get("/worker", async () => {
    const { heartbeats, aiBudget } = await heartbeatCache.get(readHeartbeats);
    // Ages are measured now, not when the rows were read, so the cache never makes a job look fresher.
    const now = Date.now();

    return {
      jobs: heartbeats.map((h) => summarizeHeartbeat(h, now)),
      // Today's AI spend against the daily cap (AI_DAILY_BUDGET_USD): totals only here - the
      // per-source split is on the admin panel.
      aiBudget: {
        day: aiBudget.day,
        capUsd: aiBudget.capUsd,
        spentUsd: aiBudget.spentUsd,
        remainingUsd: aiBudget.remainingUsd,
        stopped: aiBudget.stopped,
        backgroundPaused: aiBudget.backgroundPaused,
        resetsAt: aiBudget.resetsAt,
      },
    };
  });
}

type HeartbeatRow = Awaited<ReturnType<typeof prisma.systemHeartbeat.findMany>>[number];

/**
 * One job's row as /health/worker reports it. The admin panel's /admin/worker passes
 * `fullError` for the untruncated message - it is behind the admin gate, this route is public.
 */
export function summarizeHeartbeat(h: HeartbeatRow, now: number, opts: { fullError?: boolean } = {}) {
  const threshold = staleThresholdMs(h.job, h.meta);
  // A run in flight for longer than the stale threshold is a hung run, not a slow one -
  // reported separately because "last finished Sep 21, running since 20:33" and "last
  // finished Sep 21, nothing running" call for different fixes.
  const runningSince = runningSinceFrom(h.meta);
  const runningForMs = runningSince ? now - runningSince.getTime() : null;
  return {
    job: h.job,
    // Which worker process owns the job (render.yaml runs a scanner and a trainer), so a
    // stale row says which of the two to look at. Null for a job name this build no
    // longer knows (a row left behind by an older worker).
    role: HEARTBEAT_JOB_ROLE[h.job as HeartbeatJob] ?? null,
    lastRunAt: h.lastRunAt,
    lastSuccessAt: h.lastSuccessAt,
    lastError: h.lastError ? (opts.fullError ? h.lastError : publicErrorText(h.lastError)) : null,
    stale: now - h.lastRunAt.getTime() > threshold,
    staleAfterMs: threshold,
    runningForMs,
    hung: runningForMs !== null && runningForMs > threshold,
    // How long the last run took, and for the scan cycle where that time went - timings
    // only, nothing about tokens or users.
    lastRun: lastRunSummary(h.meta),
    // While a run is in flight, the stages it has finished so far - see recordRunProgress.
    runningStagesMs: runningSince ? stageTimings(h.meta, "runningStagesMs") : null,
  };
}

/** The timing and call-count fields of a heartbeat's meta, and nothing else it might carry. */
function lastRunSummary(meta: unknown): Record<string, unknown> | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const out: { durationMs?: number; stagesMs?: Record<string, number>; [count: string]: unknown } = {};
  // Every top-level number the job reported (duration, and counts such as tracked/inBand).
  for (const [key, value] of Object.entries(m)) {
    if (typeof value === "number" && !SCHEDULE_META_KEYS.has(key)) out[key] = value;
  }
  const stages = stageTimings(meta, "stagesMs");
  if (stages) out.stagesMs = stages;
  // The scan's paid RPC calls per method ({ method: count }) - what the Helius plan bills on.
  const rpcCalls = stageTimings(meta, "rpcCalls");
  if (rpcCalls) out.rpcCalls = rpcCalls;
  // The scan's TokenSage counters (requested, stored, turned away, waiting, pending...): counts
  // only, so whether reads are going out and coming back is visible without the admin wallet.
  // pipeline-watch: what each stage of the alert path produced in its window.
  const flows = stageTimings(meta, "flows");
  if (flows) out.flows = flows;
  const tokensage = stageTimings(meta, "tokensage");
  if (tokensage) out.tokensage = tokensage;
  return Object.keys(out).length > 0 ? out : null;
}

/** A `{ stage: ms }` object from a heartbeat's meta, numbers only, or null. */
function stageTimings(meta: unknown, key: string): Record<string, number> | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === "number",
    ),
  );
}
