import type { FastifyInstance } from "fastify";
import {
  HEARTBEAT_JOB_ROLE,
  HELIUS_CREDITS_OUT_ROW,
  JOB_LOCKED_JOBS,
  heldJobLocks,
  lockLostDuringRun,
  prisma,
  readAiBudget,
  runningSinceFrom,
  type Env,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { liveCurves } from "../liveCurve.js";
import { liveTrades } from "../liveTrades.js";
import { chartHealthForHealth } from "../chartHealth.js";
import { proTradeCounts } from "../proTradeCounters.js";

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
  // Every PRO_HOLDER_SCAN_MINUTES (5): who of the top 250 $ASDFASDFA holders has Pro Mode. Late, a
  // wallet that just bought in waits longer for it; nobody loses it (a missed scan changes no
  // one's standing), until an hour without scans turns holders into a grace period.
  "pro-holders": 20 * 60_000,
  // Every 15 seconds: the ASDF price the Sacrifice is charged at. While it is down, fee-paying
  // Pro trades are refused once the newest sample is a minute old (asdfPrice.ts guards).
  "asdf-price": 5 * 60_000,
  // Every 30 seconds: settles Pro trades no panel watched, refunding a failed one's Sacrifice.
  // Late, a refund waits; nothing is lost (it settles on the next run).
  "trade-settlement": 10 * 60_000,
  // Every minute, and while it's down every open training row's label window is silently
  // recording nothing - an hour of downtime is an hour of alerts whose outcomes read "flat".
  "candidate-watch": 10 * 60_000,
  // Every MATCH_PEAKS_INTERVAL_MINUTES (2 by default). Nothing time-critical waits on it -
  // peaks feed the leaderboard and outcome figures - so a generous margin.
  "match-peaks": 20 * 60_000,
  // Every TELEGRAM_DISPATCH_INTERVAL_SECONDS (10 by default). While it is down linked Telegram
  // chats hear nothing, and nothing else notices.
  "telegram-dispatch": 10 * 60_000,
  // Every WEB_PUSH_DISPATCH_INTERVAL_SECONDS (10 by default). While it is down phones and closed
  // dashboards get no push notifications; an open dashboard still notifies on its own.
  "web-push-dispatch": 10 * 60_000,
  // Every minute: says when a stage of the alert path stops producing (pipelineWatchJob.ts).
  "pipeline-watch": 10 * 60_000,
  // Every TRADING_BOT_INTERVAL_SECONDS (5 by default) when the trading bot is on; while it is down
  // open positions are not watched for their exits.
  "trading-bot": 5 * 60_000,
  // Every TRADE_CANARY_INTERVAL_MINUTES (15 by default; its heartbeat interval raises this to 45
  // min): builds a Pro trade without signing it (tradeCanaryJob.ts). pipeline-watch tells the
  // admins after two failed runs; this only says it stopped running.
  "trade-canary": 30 * 60_000,
  // Every PAPER_TRADING_INTERVAL_MS (10s): admins' paper strategies; nothing else waits on it.
  "paper-trading": 10 * 60_000,
  cleanup: 26 * 3_600_000,
  "outcome-tracking": 26 * 3_600_000,
  // Runs every CURATOR_TRAINING_INTERVAL_HOURS (12h by default; its heartbeat interval raises this), not daily - same "expected
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
  // Hourly: rebuilds the dev launch scores (devLaunchRiskJob.ts).
  "dev-launch-risk": 3 * 3_600_000,
  // Hourly: the Side Wallet Checker's lists, from the trade tape (kolSideWalletsJob.ts).
  "kol-side-wallets": 3 * 3_600_000,
  // Daily: the KOL roster from Solana Tracker (kolWalletsJob.ts). Nothing user-facing waits on it.
  "kol-wallets": 26 * 3_600_000,
};
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60_000;
/** The worker's deadline on a training run (curator-training's deadlineMinutes in apps/worker/src/index.ts). */
const TRAINING_DEADLINE_MS = 240 * 60_000;
/**
 * A run in flight is hung after its job's stale threshold - unless the job's runs are far shorter
 * than that. Training's threshold is a whole interval and more (it runs every twelve hours by
 * default): going by the threshold, a stuck run read "running" on the admin panel until the worker
 * restarted under it.
 *
 * Training reports each exam as it starts (runningStep), so for it this is how long the run may go
 * without a new step, not how long it may run: its runs took 82 minutes on 2026-10-22 and 130 on
 * 2026-10-27, nearly all exams of a few minutes each, and a 45-minute cap on the whole run read a
 * run on its 21st exam of 26 as hung (user report 2026-10-27). One past TRAINING_DEADLINE_MS is
 * hung however it moves.
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
 * The strict jobs that are stale, failing every run, or have no heartbeat row at all, by the same
 * `stale` and `failing` the body reports. Pure, so the route's status code and its tests agree on
 * one definition. Failing counts: a failed run still advances lastRunAt, so a scan failing every
 * cycle used to read as healthy here for as long as it kept failing.
 */
export function strictWorkerFailures(jobs: { job: string; stale: boolean; failing?: boolean }[]): string[] {
  return STRICT_WORKER_JOBS.filter((job) => {
    const row = jobs.find((j) => j.job === job);
    // pipeline-watch's failed runs are its reports (a trainer job failing, a filling disk), not
    // the watcher failing; only its silence counts here.
    return !row || row.stale || (row.failing === true && job !== "pipeline-watch");
  });
}

/**
 * Whether a job has gone its stale threshold without a successful run: every run in that time
 * failed (a job that has never succeeded, every run so far). Separate from `stale` (no run at
 * all), since the two call for different fixes.
 */
export function isFailing(lastSuccessAt: Date | null, thresholdMs: number, now: number): boolean {
  return lastSuccessAt === null || now - lastSuccessAt.getTime() > thresholdMs;
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
      return {
        ok: true,
        db: true,
        liveCurves: liveCurves().stats(),
        liveTrades: liveTrades().stats(),
        charts: chartHealthForHealth(),
        proTrades: proTradeCounts(),
      };
    }
    // The charts' live curve tails on this instance (liveCurve.ts): curves followed, how many the
    // chart socket covers, and that socket's traffic and estimated Helius credits since boot. The
    // token pages' live trades (liveTrades.ts) likewise, for their own socket. And this instance's
    // Pro trade builds and sends by outcome (proTradeCounters.ts), so a spike of 503s shows.
    // `charts`: the charts' health over the last 5 minutes (chartHealth.ts), informational: it
    // never fails /health.
    return {
      ok: true,
      liveCurves: liveCurves().stats(),
      liveTrades: liveTrades().stats(),
      charts: chartHealthForHealth(),
      proTrades: proTradeCounts(),
    };
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
    const [rows, aiBudget, lastAlert, lastRead, lastDecision, lastSecondLook, heldLocks] = await Promise.all([
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
    // The shared Helius stand-down (apiUsage.ts) lives in this table but is not a job.
    const heartbeats = rows.filter((h) => h.job !== HELIUS_CREDITS_OUT_ROW);
    const creditsOut = sharedCreditsOut(rows.find((h) => h.job === HELIUS_CREDITS_OUT_ROW)?.meta);
    const watchMeta = heartbeats.find((h) => h.job === "pipeline-watch")?.meta as
      Record<string, unknown> | null | undefined;
    const heliusPlan = heliusPlanOf(watchMeta?.heliusPlan);
    const watch = watchAlarmsOf(watchMeta);
    const scanMeta = heartbeats.find((h) => h.job === "scan")?.meta as Record<string, unknown> | null;
    const screenPass = scanMeta?.lastScreenPassAt;
    // When each stage of the alert path last produced something (the header pill's tooltip).
    const pipeline = {
      lastAlertAt: lastAlert._max.createdAt,
      lastPreCheckPassAt: typeof screenPass === "number" ? new Date(screenPass) : null,
      lastTokenSageAt: lastRead._max.checkedAt,
      lastDecisionAt: latest(lastDecision._max.anchorAt, lastSecondLook._max.anchorAt),
    };
    return { heartbeats, aiBudget, pipeline, heldLocks, creditsOut, heliusPlan, watch };
  };
  const heartbeatCache = new SharedCache<Awaited<ReturnType<typeof readHeartbeats>>>(WORKER_HEALTH_CACHE_MS);

  // `?strict=1`: the same body, but a 503 while any of STRICT_WORKER_JOBS is stale or missing, so
  // a monitor that only reads status codes can alert on it. Without it the route always answers
  // 200 and the dashboard reads the flags from the body, as it always has.
  app.get<{ Querystring: { strict?: string } }>("/worker", async (request, reply) => {
    const { heartbeats, aiBudget, pipeline, heldLocks, creditsOut, heliusPlan, watch } =
      await heartbeatCache.get(readHeartbeats);
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
      // While Helius's credits are out, every process's stand-down (apiUsage.ts): since and until when.
      heliusCreditsOut: creditsOut && creditsOut.until > now ? creditsOut : null,
      // The Helius plan against its billing cycle, as pipeline-watch last read it (HELIUS_MONTHLY_CREDITS;
      // null with that unset): credits so far, the last day's, and when that rate runs the plan out.
      heliusPlan,
      // The run-out warnings pipeline-watch keeps (full audit 2026-10-27, T3), figures only: Helius
      // credits in the last 24 h against the usual day, with no plan size needed; training's last
      // completed run against its deadline; the scan cycle's median time to its decisions, and the
      // fast path's and early decisions' own; and
      // alerts Telegram dropped unsent in the episode in progress.
      heliusBurn: watch.heliusBurn,
      training: watch.training,
      scanLatency: watch.scanLatency,
      telegramAgedOut: watch.telegramAgedOut,
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

/** The plan figures pipeline-watch's heartbeat carries (apps/worker/src/jobs/heliusBudget.ts), or null. */
function heliusPlanOf(meta: unknown) {
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as Record<string, unknown>;
  if (typeof m.planCredits !== "number" || typeof m.cycleCredits !== "number") return null;
  const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  const num = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : null);
  return {
    planCredits: m.planCredits,
    cycleStart: str("cycleStart"),
    cycleEnd: str("cycleEnd"),
    countedSince: str("countedSince"),
    cycleCredits: m.cycleCredits,
    usedPct: Math.round((m.cycleCredits / m.planCredits) * 1000) / 10,
    last24h: num("last24h"),
    projectedCycle: num("projectedCycle"),
    projectedRunOutAt: str("projectedRunOutAt"),
    checkedAt: str("checkedAt"),
  };
}

/** The run-out warnings' figures from pipeline-watch's heartbeat (apps/worker/src/jobs/pipelineWatchJob.ts). */
export function watchAlarmsOf(meta: Record<string, unknown> | null | undefined) {
  const obj = (k: string) => {
    const v = meta?.[k];
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };
  const num = (m: Record<string, unknown> | null, k: string) =>
    m && typeof m[k] === "number" && Number.isFinite(m[k]) ? (m[k] as number) : null;
  const str = (m: Record<string, unknown> | null, k: string) =>
    m && typeof m[k] === "string" ? (m[k] as string) : null;

  const burn = obj("heliusBurn");
  const last24h = num(burn, "last24h");
  const baselineDaily = num(burn, "baselineDaily");
  const heliusBurn =
    last24h === null
      ? null
      : {
          last24h,
          baselineDaily,
          baselineDays: num(burn, "baselineDays"),
          ratio: baselineDaily ? Math.round((last24h / baselineDaily) * 100) / 100 : null,
          checkedAt: str(burn, "checkedAt"),
        };

  const t = obj("training");
  const lastCompletedMs = num(t, "lastCompletedMs");
  const training = t
    ? {
        deadlineMs: TRAINING_DEADLINE_MS,
        lastCompletedAt: str(t, "lastCompletedAt"),
        lastCompletedMs,
        deadlineUsedPct:
          lastCompletedMs === null ? null : Math.round((lastCompletedMs / TRAINING_DEADLINE_MS) * 100),
      }
    : null;

  const scan = obj("scanLatency");
  // Comma-separated milliseconds: heartbeat meta holds no arrays.
  const windowOf = (k: string) =>
    (str(scan, k) ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  const p50 = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
  };
  const samples = windowOf("samples");
  const fast = windowOf("fastSamples");
  const early = windowOf("earlySamples");
  // The cycle's barrier, and the decisions made apart from it (check-in 2026-10-29, B): the entry
  // fast path's crossing-to-decision time and the early-decided coins' time from the cycle's start,
  // each the median over the last cycles that had one (null before any).
  const scanLatency =
    samples.length === 0 && fast.length === 0 && early.length === 0
      ? null
      : {
          cycles: samples.length,
          decidedMsP50: samples.length === 0 ? null : p50(samples),
          fastPathCycles: fast.length,
          fastPathDecisionMsP50: fast.length === 0 ? null : p50(fast),
          earlyCycles: early.length,
          earlyDecisionMsP50: early.length === 0 ? null : p50(early),
        };

  const aged = obj("telegramAgedOut");
  const telegramAgedOut = aged
    ? { count: num(aged, "count") ?? 0, since: str(aged, "since"), lastAt: str(aged, "lastAt") }
    : null;

  return { heliusBurn, training, scanLatency, telegramAgedOut };
}

/** The shared Helius stand-down row's times (apiUsage.ts writes them as ms epochs), or null. */
function sharedCreditsOut(meta: unknown): { since: number; until: number } | null {
  if (typeof meta !== "object" || meta === null) return null;
  const { since, until } = meta as Record<string, unknown>;
  return typeof since === "number" && typeof until === "number" ? { since, until } : null;
}

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
  // A run that lost its lock's connection and couldn't take it again (lockLostDuringRun) is still
  // going without it, so its free lock proves nothing.
  const orphaned =
    opts.heldLocks != null &&
    LOCKED_JOBS.has(h.job) &&
    runningForMs !== null &&
    runningForMs > ORPHAN_GRACE_MS &&
    !opts.heldLocks.has(h.job) &&
    !lockLostDuringRun(h.meta, runningSince);
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
    // Running, but no run has succeeded for as long as `stale` allows (see isFailing).
    failing: isFailing(h.lastSuccessAt, threshold, now),
    staleAfterMs: threshold,
    runningForMs,
    hung: orphaned || isHungRun(h.job, h.meta, runningSince, threshold, now),
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

/**
 * Whether the run in flight is hung (see HUNG_AFTER_MS): past its job's limit since it started, or,
 * for a run that reports its steps, since its latest step began.
 */
function isHungRun(
  job: string,
  meta: unknown,
  runningSince: Date | null,
  threshold: number,
  now: number,
): boolean {
  if (!runningSince) return false;
  const runningForMs = now - runningSince.getTime();
  const limit = Math.min(threshold, HUNG_AFTER_MS[job] ?? threshold);
  if (job !== "curator-training") return runningForMs > limit;
  if (runningForMs > TRAINING_DEADLINE_MS) return true;
  // A step stamped before this run began is the last run's, not progress.
  const stepAt = Date.parse(runningStep(meta)?.since ?? "");
  const movedAt = Number.isFinite(stepAt) ? Math.max(stepAt, runningSince.getTime()) : runningSince.getTime();
  return now - movedAt > limit;
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
  // champion-refresh: how many seat live-share alarms are up (runGuard.ts liveShareAlarms; MT-11).
  // Their text names seats and shares and stays on the admin panel; the count says one is up.
  if (typeof m.shareAlarms === "string") {
    out.shareAlarms = m.shareAlarms.split("; ").filter(Boolean).length;
  }
  const stages = stageTimings(meta, "stagesMs");
  if (stages) out.stagesMs = stages;
  // The scan's paid RPC calls per method ({ method: count }) - what the Helius plan bills on.
  const rpcCalls = stageTimings(meta, "rpcCalls");
  if (rpcCalls) out.rpcCalls = rpcCalls;
  // The scan's market-data calls since the last cycle (requests, 429 pauses, time queued, gave
  // up): whether DexScreener is throttling the shared budget, and how much Jupiter took off it.
  // Who priced the newest launches (liveLaunchQuotes), and the entry fast path's crossings, first
  // scans, calls, skips and crossing-to-decision times (entryFastPath); the new launches' Mayhem
  // verdicts between cycles and how fast they landed (launchScreen). The cycle's RugCheck reports: cached, and
  // looked up while it waited (rugCheckLookups). The linked-wallet funder reads and their credits
  // (linkedWalletCalls), and the holder-transfer reads (holderTransferCalls) with the Helius stream that spares them (heliusStream). The young coins' curve tape and its spend (curveTape). The live tape's pages before a call (liveTape). The Helius credits of the freshness, balance and on-chain holder stages (heliusStageCredits). Jupiter's newest-launch
  // reads between cycles and the launches they found (launchPoller). The chart's candle store: the
  // curve tape's 1-second rows (curveCandles), the backfill to launch (candleBackfill), and the
  // chain fill's pages, rows and day's credits (candleChainFill).
  for (const key of [
    "dexScreenerCalls",
    "jupiterCalls",
    "liveLaunchQuotes",
    "entryFastPath",
    // The contenders decided before the barrier: coins, waves, the first wave's and the median
    // coin's time from the cycle's start (scanJob.ts decideEarly; post-fix eval 2026-10-28).
    "earlyDecisions",
    "launchScreen",
    "rugCheckLookups",
    "linkedWalletCalls",
    "holderTransferCalls",
    "heliusStream",
    "curveTape",
    "pumpfunGate",
    "liveTape",
    "heliusStageCredits",
    "pumpfunList",
    "launchDetails",
    // Launch details read through TokenSage's Pump.fun relay while Pump.fun refuses us
    // (worker pumpRelay.ts; check-in 2026-10-29).
    "pumpRelay",
    "launchPoller",
    "curveCandles",
    "candleBackfill",
    "candleChainFill",
    // Ready coins held back from a decision, by what held them: the cycle's and since boot
    // (decisionHolds.ts; audit 2026-10-27, DS-9 - written since 10-14 but never shown).
    "decisionHolds",
    "decisionHoldsSinceBoot",
    // champion-refresh: the seats' record on the fast path's own moments (moments, graded, won2x
    // over windowHours; the per-seat line stays on the admin panel) - MT-11.
    "fastPath",
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
  // pipeline-watch: the Pro trades sent in its window, and how many failed or expired.
  const tradeOutcomes = stageTimings(meta, "tradeOutcomes");
  if (tradeOutcomes) out.tradeOutcomes = tradeOutcomes;
  // The trade canary: each probe's result ("ok", "degraded", "failed", "skipped") and time, and the coins it
  // built on (public mints). Why a probe failed is the row's lastError.
  const probes = stringFields(meta, "probes");
  if (probes) out.probes = probes;
  const probeMs = stageTimings(meta, "probeMs");
  if (probeMs) out.probeMs = probeMs;
  for (const key of ["graduatedMint", "curveMint"] as const) {
    if (typeof m[key] === "string") out[key] = m[key];
  }
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

/** A `{ name: text }` object from a heartbeat's meta, strings only, or null. */
function stringFields(meta: unknown, key: string): Record<string, string> | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
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
