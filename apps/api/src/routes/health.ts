import type { FastifyInstance } from "fastify";
import {
  HEARTBEAT_JOB_ROLE,
  JOB_LOCKED_JOBS,
  heldJobLocks,
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
  // Every 5 minutes: cleans up after a Free Access period ends. Late, it leaves free accounts
  // standing a while longer; nothing else waits on it.
  "free-access": 30 * 60_000,
  // Every minute, and while it's down every open training row's label window is silently
  // recording nothing - an hour of downtime is an hour of alerts whose outcomes read "flat".
  "candidate-watch": 10 * 60_000,
  // Every MATCH_PEAKS_INTERVAL_MINUTES (2 by default). Nothing time-critical waits on it -
  // peaks feed the leaderboard and outcome figures - so a generous margin.
  "match-peaks": 20 * 60_000,
  // Every TELEGRAM_DISPATCH_INTERVAL_SECONDS (10 by default). While it is down linked Telegram
  // chats hear nothing, and nothing else notices.
  "telegram-dispatch": 10 * 60_000,
  // Every minute: says when a stage of the alert path stops producing (pipelineWatchJob.ts).
  "pipeline-watch": 10 * 60_000,
  // Every TRADING_BOT_INTERVAL_SECONDS (5 by default) when the trading bot is on; while it is down
  // open positions are not watched for their exits.
  "trading-bot": 5 * 60_000,
  // Every PAPER_TRADING_INTERVAL_MS (10s): admins' paper strategies; nothing else waits on it.
  "paper-trading": 10 * 60_000,
  cleanup: 26 * 3_600_000,
  "outcome-tracking": 26 * 3_600_000,
  // Runs every CURATOR_TRAINING_INTERVAL_HOURS (6h by default; its heartbeat interval raises this), not daily - same "expected
  // cadence + 2h" buffer as the daily jobs above, scaled to its own interval.
  "curator-training": 4 * 3_600_000,
  // Every 10 minutes; replay batches and playbook rounds wait on it, nothing user-facing does.
  "ai-judge": 40 * 60_000,
  // Hourly: re-chooses the default model from the leaderboard between training runs.
  "champion-refresh": 3 * 3_600_000,
  // Hourly: takes the weekly model backup when one is due and copies new ones off-site.
  "model-backup": 3 * 3_600_000,
  // Nightly, from its own Render cron (scripts/db-backup/backup.sh); the row exists once it has run.
  "db-dump": 26 * 3_600_000,
  // Every SCORE_WEIGHTS_INTERVAL_HOURS (6): refits the composite score's weights.
  "score-weights": 14 * 3_600_000,
  // Hourly: sums the Lighthouse's history (apps/worker/src/jobs/lighthouseRollupJob.ts).
  "lighthouse-rollup": 3 * 3_600_000,
  // Every minute while history is being re-graded to label rule 4 (labelRegradeJob.ts), then a
  // no-op; nothing user-facing waits on it.
  "label-regrade": 30 * 60_000,
  // Every minute: alerts' Peak/ATH from the coins' candles. Late, a Peak lags the coin a while.
  "candle-peaks": 30 * 60_000,
  // Every minute: reads called coins' trades for the wallet risk score (tradeTapeJob.ts). Nothing
  // user-facing waits on it.
  "trade-tape": 30 * 60_000,
  // Hourly: rebuilds the wallet risk scores from the trade tape (walletRiskJob.ts).
  "wallet-risk": 3 * 3_600_000,
  // Hourly: the Side Wallet Checker's lists, from the trade tape (kolSideWalletsJob.ts).
  "kol-side-wallets": 3 * 3_600_000,
  // Daily: the KOL roster from Solana Tracker (kolWalletsJob.ts). Nothing user-facing waits on it.
  "kol-wallets": 26 * 3_600_000,
};
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000;
/**
 * A run in flight is hung after its job's stale threshold - unless the job's runs are far shorter
 * than that. Training's threshold is a whole interval and more (it runs every six hours), but a run
 * takes about fifteen minutes and the worker gives up on one at 90: going by the threshold, a stuck
 * run read "running" on the admin panel until the worker restarted under it.
 */
const HUNG_AFTER_MS: Record<string, number> = {
  "curator-training": 45 * 60_000,
  // Daily jobs whose stale threshold is 26 hours: a run takes 3-16 minutes (30 at the worst seen),
  // and an outcome-tracking run lost at 20:05 on 2026-10-16 read "running, not hung" all night.
  "outcome-tracking": 90 * 60_000,
  cleanup: 90 * 60_000,
};
/**
 * A lock-guarded run (JOB_LOCKED_JOBS) is lost, not running, when its lock is free this long after
 * it started: the stamp goes down a moment before the lock is taken, and a deploy's skipped run
 * stamps too while the other process holds the lock.
 */
const ORPHAN_GRACE_MS = 2 * 60_000;
const LOCKED_JOBS = new Set<string>(JOB_LOCKED_JOBS);
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
  return (
    (error.split("\n")[0] ?? "")
      .replace(/https?:\/\/\S+/g, "<url>")
      // Prisma's engine quotes them apart: Can't reach database server at `dpg-x.render.com`:`5432`.
      .replace(/`[^`]+`:`\d{2,5}`/g, "<host>")
      .replace(/\b[a-z0-9.-]+\.[a-z]{2,}:\d{2,5}\b/gi, "<host>")
      .replace(/\b[a-z0-9-]+:\d{2,5}\b/gi, "<host>")
      // A bare hostname, as in "getaddrinfo ENOTFOUND dpg-x.oregon-postgres.render.com".
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|dev|cloud|internal|local)\b/gi, "<host>")
      .slice(0, MAX_ERROR_LENGTH)
  );
}

/**
 * How long one read of the heartbeats answers /health/worker. The route is public and was a
 * database query per call, so anyone could spend the API's twelve pool connections on it at the
 * global rate limit; heartbeats move once a job finishes, so a few seconds hide nothing.
 */
const WORKER_HEALTH_CACHE_MS = 5_000;

/**
 * What `GET /health/worker?strict=1` holds to its status code: the alert path's jobs, and
 * pipeline-watch - the scanner's own once-a-minute pulse, so a scanner that is down or cut off
 * from the database reads as one even while its last scan row is still young. The watcher lives
 * in the process it watches and can't say that itself; an outside uptime monitor pointed here can.
 */
export const STRICT_WORKER_JOBS: readonly HeartbeatJob[] = [
  "scan",
  "fast-match",
  "candidate-watch",
  "telegram-dispatch",
  "pipeline-watch",
];

/**
 * The strict jobs that are stale or have no heartbeat row at all, by the same `stale` the body
 * reports. Pure, so the route's status code and its tests agree on one definition.
 */
export function strictWorkerFailures(jobs: { job: string; stale: boolean }[]): string[] {
  return STRICT_WORKER_JOBS.filter((job) => {
    const row = jobs.find((j) => j.job === job);
    return !row || row.stale;
  });
}

/** The later of two optional times. */
function latest(a: Date | null, b: Date | null): Date | null {
  if (!a || !b) return a ?? b;
  return a > b ? a : b;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  opts: {
    env?: Pick<Env, "AI_DAILY_BUDGET_USD" | "AI_BUDGET_REVIEW_RESERVE_PCT">;
    /** True from listen until the report keeper's first pass is done (server.ts). */
    warming?: () => boolean;
  } = {},
) {
  const budgetEnv = opts.env ?? { AI_DAILY_BUDGET_USD: 15, AI_BUDGET_REVIEW_RESERVE_PCT: 40 };
  /** Plain liveness check - what Render's healthCheckPath hits. */
  // A fresh instance reports unhealthy until its report caches are filled (capped in server.ts), so
  // a deploy keeps traffic on the old instance meanwhile and no reader meets an empty cache.
  // `?db=1` also runs one trivial query, for an outside monitor: a database Render has suspended
  // (its disk full) takes every in-process watcher down with it, and this is the signal left.
  // Render's own probe stays on the plain route, so a database blip does not restart the API.
  app.get<{ Querystring: { db?: string } }>("/", async (request, reply) => {
    if (opts.warming?.()) return reply.code(503).send({ ok: false, warming: true });
    if (request.query.db === "1" || request.query.db === "true") {
      const db = await prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      );
      if (!db) return reply.code(503).send({ ok: false, db: false });
      return { ok: true, db: true };
    }
    return { ok: true };
  });

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
    const [heartbeats, aiBudget, lastAlert, lastRead, lastDecision, lastSecondLook, heldLocks] =
      await Promise.all([
        prisma.systemHeartbeat.findMany({ orderBy: { job: "asc" } }),
        readAiBudget(budgetEnv),
        // Newest row of each, each one a backward step down its own index.
        prisma.curatedAlert.aggregate({ _max: { createdAt: true } }),
        prisma.tokenNarrative.aggregate({ _max: { checkedAt: true } }),
        prisma.candidateOutcome.aggregate({ where: { sampleKind: "event" }, _max: { anchorAt: true } }),
        // The Narrative seat's second look is a model considering a token too.
        prisma.candidateOutcome.aggregate({ where: { sampleKind: "second" }, _max: { anchorAt: true } }),
        heldJobLocks(),
      ]);
    const scanMeta = heartbeats.find((h) => h.job === "scan")?.meta as Record<string, unknown> | null;
    const screenPass = scanMeta?.lastScreenPassAt;
    // When each stage of the alert path last produced something (the header pill's tooltip).
    const pipeline = {
      lastAlertAt: lastAlert._max.createdAt,
      lastPreCheckPassAt: typeof screenPass === "number" ? new Date(screenPass) : null,
      lastTokenSageAt: lastRead._max.checkedAt,
      lastDecisionAt: latest(lastDecision._max.anchorAt, lastSecondLook._max.anchorAt),
    };
    return { heartbeats, aiBudget, pipeline, heldLocks };
  };
  const heartbeatCache = new SharedCache<Awaited<ReturnType<typeof readHeartbeats>>>(WORKER_HEALTH_CACHE_MS);

  // `?strict=1`: the same body, but a 503 while any of STRICT_WORKER_JOBS is stale or missing, so
  // a monitor that only reads status codes can alert on it. Without it the route always answers
  // 200 and the dashboard reads the flags from the body, as it always has.
  app.get<{ Querystring: { strict?: string } }>("/worker", async (request, reply) => {
    const { heartbeats, aiBudget, pipeline, heldLocks } = await heartbeatCache.get(readHeartbeats);
    // Ages are measured now, not when the rows were read, so the cache never makes a job look fresher.
    const now = Date.now();
    const jobs = heartbeats.map((h) => summarizeHeartbeat(h, now, { heldLocks }));
    const strict = request.query.strict === "1" || request.query.strict === "true";
    const failing = strict ? strictWorkerFailures(jobs) : [];
    if (failing.length > 0) reply.code(503);

    return {
      ...(strict ? { failing } : {}),
      jobs,
      pipeline,
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
export function summarizeHeartbeat(
  h: HeartbeatRow,
  now: number,
  opts: { fullError?: boolean; heldLocks?: ReadonlySet<string> | null } = {},
) {
  const threshold = staleThresholdMs(h.job, h.meta);
  // A run in flight for longer than the stale threshold is a hung run, not a slow one -
  // reported separately because "last finished Sep 21, running since 20:33" and "last
  // finished Sep 21, nothing running" call for different fixes.
  const runningSince = runningSinceFrom(h.meta, h.lastRunAt);
  const runningForMs = runningSince ? now - runningSince.getTime() : null;
  // A lock-guarded run whose lock nobody holds: its process died without its shutdown path, so
  // the run is gone and nothing will clear the stamp before the job's next run. Only judged when
  // the caller read the locks (heldJobLocks).
  const orphaned =
    opts.heldLocks != null &&
    LOCKED_JOBS.has(h.job) &&
    runningForMs !== null &&
    runningForMs > ORPHAN_GRACE_MS &&
    !opts.heldLocks.has(h.job);
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
    hung:
      orphaned ||
      (runningForMs !== null && runningForMs > Math.min(threshold, HUNG_AFTER_MS[h.job] ?? threshold)),
    // The run in flight was lost with its process (see above), not still going.
    orphaned,
    // How long the last run took, and for the scan cycle where that time went - timings
    // only, nothing about tokens or users.
    lastRun: lastRunSummary(h.meta),
    // While a run is in flight, the stages it has finished so far - see recordRunProgress.
    runningStagesMs: runningSince ? stageTimings(h.meta, "runningStagesMs") : null,
    // And the step under way now, with when it began (training's "exams: examining Trees (5 of up
    // to 24)") - a step that has sat unchanged for a long while is where a stuck run is stuck.
    runningStep: runningSince ? runningStep(h.meta) : null,
  };
}

/** The timing and call-count fields of a heartbeat's meta, and nothing else it might carry. */
function lastRunSummary(meta: unknown): Record<string, unknown> | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const out: { durationMs?: number; stagesMs?: Record<string, number>; [count: string]: unknown } = {};
  // Every top-level number or flag the job reported (duration, counts such as tracked/inBand,
  // the cleanup's fullSnapshotWalk).
  for (const [key, value] of Object.entries(m)) {
    if ((typeof value === "number" || typeof value === "boolean") && !SCHEDULE_META_KEYS.has(key)) {
      out[key] = value;
    }
  }
  // Why a run did nothing (the AI judge's "reviewer off"): without it a skipped run reads as a
  // healthy few-millisecond success. The cleanup's stage names likewise: the stages it held back
  // because the match copies did not land, and the ones a resumed run skipped - without them a
  // held stage's 0 reads as "nothing old enough yet".
  for (const key of ["skipped", "heldStages", "resumedSkippedStages"] as const) {
    if (typeof m[key] === "string") out[key] = m[key];
  }
  const stages = stageTimings(meta, "stagesMs");
  if (stages) out.stagesMs = stages;
  // The scan's paid RPC calls per method ({ method: count }) - what the Helius plan bills on.
  const rpcCalls = stageTimings(meta, "rpcCalls");
  if (rpcCalls) out.rpcCalls = rpcCalls;
  // The scan's market-data calls since the last cycle (requests, 429 pauses, time queued, gave
  // up): whether DexScreener is throttling the shared budget, and how much Jupiter took off it.
  // Who priced the newest launches (liveLaunchQuotes), and the band-entry checks between cycles
  // and the cycles they started early (bandEntryWatch). The cycle's RugCheck reports: cached, and
  // looked up while it waited (rugCheckLookups). The linked-wallet funder reads and their credits
  // (linkedWalletCalls), and the holder-transfer reads (holderTransferCalls) with the Helius stream that spares them (heliusStream). The young coins' curve tape and its spend (curveTape). The live tape's pages before a call (liveTape). Jupiter's newest-launch
  // reads between cycles and the launches they found (launchPoller).
  for (const key of [
    "dexScreenerCalls",
    "jupiterCalls",
    "liveLaunchQuotes",
    "bandEntryWatch",
    "rugCheckLookups",
    "linkedWalletCalls",
    "holderTransferCalls",
    "heliusStream",
    "curveTape",
    "pumpfunGate",
    "liveTape",
    "pumpfunList",
    "launchDetails",
    "launchPoller",
  ] as const) {
    const calls = stageTimings(meta, key);
    if (calls) out[key] = calls;
  }
  // Pump.fun's coin list (pages asked and failed, with the last failure) and the one-coin
  // fallback's counts: a list failing every page means launches arrive from the stream alone.
  const listError = (m.pumpfunList as { lastError?: unknown } | undefined)?.lastError;
  if (out.pumpfunList && typeof listError === "string") {
    out.pumpfunList = { ...(out.pumpfunList as object), lastError: listError.slice(0, 200) };
  }
  // The scan's TokenSage counters (requested, stored, turned away, waiting, pending...): counts
  // only, so whether reads are going out and coming back is visible without the admin wallet.
  // pipeline-watch: what each stage of the alert path produced in its window.
  const flows = stageTimings(meta, "flows");
  if (flows) out.flows = flows;
  const tokensage = stageTimings(meta, "tokensage");
  if (tokensage) out.tokensage = tokensage;
  // The scan's launch first-buyer reads (the top-10 snipers share): requested, found, failed.
  const sniperReads = stageTimings(meta, "sniperReads");
  if (sniperReads) out.sniperReads = sniperReads;
  return Object.keys(out).length > 0 ? out : null;
}

/** A `{ stage: ms }` object from a heartbeat's meta, numbers only, or null. */
function runningStep(meta: unknown): { step: string; since: string | null } | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  if (typeof m.runningStep !== "string") return null;
  return { step: m.runningStep, since: typeof m.runningStepAt === "string" ? m.runningStepAt : null };
}

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
