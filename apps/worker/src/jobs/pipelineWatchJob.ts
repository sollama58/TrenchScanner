import {
  prisma,
  adminWalletSet,
  createLogger,
  escapeHtml,
  HEARTBEAT_JOB_ROLE,
  heldJobLocks,
  heliusCreditsOut,
  JOB_LOCKED_JOBS,
  lockLostDuringRun,
  runningSinceFrom,
  TelegramApi,
  type Env,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { JobFailure, SHUTDOWN_INTERRUPTED_ERROR, STOPPED_ERROR, type JobRunMeta } from "../scheduler.js";
import { exitForRestart } from "../processExit.js";
import { checkHeliusPlan, readPlanState, type HeliusPlanState } from "./heliusBudget.js";

const logger = createLogger("pipeline-watch");

/**
 * Watches the path from a new launch to a user's alert and says when a stage stops producing.
 *
 * On 2026-10-08 TokenSage reads stopped for an hour (one request that never returned held the
 * sender) and nothing said so: every job's heartbeat stayed green, because each job kept running.
 * A heartbeat says a job ran, not that anything came out of it. This job counts what each stage
 * produced recently, straight from the tables it writes, and flags a stage that produced nothing
 * in its window although it did in the day before (so a stage that is switched off, or never
 * used, never raises an alarm). It also flags the alert-path jobs whose own heartbeat has gone
 * quiet or whose run has not returned.
 *
 * A flagged stage makes the run fail with a message naming it, so it shows as this job's error
 * on /health/worker and on the admin panel, and the admin wallets' private Telegram chats get one
 * message when it starts and one when it clears.
 *
 * The trainer's jobs are watched from here too: the trainer has no Telegram token to say anything
 * itself, and a trainer that stopped quietly freezes the models and lets the nightly sweeps lapse
 * (the disk-full incidents). Those only notify the admins - restarting the scanner would not
 * help them, and visitors' alerts are not delayed by them.
 *
 * The database's size is watched the same way (DB_DISK_ALERT_MB): a full disk stops every write
 * at once and leaves no room to reclaim space in place, so the warning has to come while there is
 * still room to act - raise the disk, or run the cleanup early. The size goes on the heartbeat
 * (databaseMb), so /health/worker shows it between warnings.
 *
 * So are Helius's credits (findCreditProblems): when Helius answers "max usage reached" the
 * scanner stands its Helius calls down, and the admins hear once when that starts and once when it
 * clears; the heartbeat carries heliusCreditsOutUntil meanwhile. The flows that outage empties
 * (the screen fails closed without Helius) are put down to it, not to a stall: no restart, and a
 * banner that names the cause instead (creditsOutFlows).
 *
 * And so is Pro trading (trading robustness audit 2026-10-19, #6): the trade canary's failed runs
 * in a row (findCanaryProblems - tradeCanaryJob.ts builds a trade every 15 minutes, never signing)
 * and the share of recent Pro trades that failed or expired (findTradeOutcomeProblems). Both only
 * notify: a restart mends neither Jupiter nor the chain, and alerts still flow meanwhile.
 */

export interface FlowCheck {
  key: string;
  label: string;
  windowMinutes: number;
  /** Produced in the window. */
  recent: number;
  /** Produced in the day before the window; 0 means the stage isn't in use, so it isn't judged. */
  baseline: number;
}

export interface JobCheck {
  job: HeartbeatJob;
  lastRunAt: Date | null;
  /**
   * When a run last succeeded, and the last error: a failed run still advances lastRunAt, so a job
   * failing every run looked like a healthy one here. Undefined when not read (not judged).
   */
  lastSuccessAt?: Date | null;
  lastError?: string | null;
  /** The cadence the job reported (scheduler meta.intervalMs). */
  intervalMs: number | null;
  runningSince: Date | null;
}

/** The flows judged, and each one's window: a few times the gap a healthy day ever shows. */
export const FLOW_WINDOWS_MINUTES = {
  /** New tokens (Token.firstSeenAt): pump.fun launches several a minute, day and night. */
  discovery: 15,
  /** Decision rows (CandidateOutcome "event"): the moments every model decides on. */
  decisions: 30,
  /** TokenSage reads stored (TokenNarrative.checkedAt). */
  tokensage: 15,
  /** Model alerts (CuratedAlert). Quieter than the rest, so the longest window. */
  modelAlerts: 90,
} as const;

const FLOW_LABELS: Record<keyof typeof FLOW_WINDOWS_MINUTES, string> = {
  discovery: "New tokens discovered",
  decisions: "Decision moments for the models",
  tokensage: "TokenSage reads stored",
  modelAlerts: "Model alerts",
};

/** The jobs on the alert path; a quiet heartbeat on any of them stops alerts. */
export const WATCHED_JOBS: HeartbeatJob[] = ["scan", "fast-match", "candidate-watch", "telegram-dispatch"];
/**
 * The scanner's jobs off the alert path that users still wait on: burn-scan credits a burn whose
 * owner closed the tab (a hung run left them locked out until a deploy), live-price moves the
 * Live feed's market caps. Watched like the alert path's jobs, but only notified: no banner and no
 * restart, since alerts are not delayed by them.
 */
export const SIDE_JOBS: HeartbeatJob[] = ["burn-scan", "live-price"];
/** A job is quiet after this many of its own intervals without a run, and never sooner than the floor. */
const JOB_QUIET_INTERVALS = 5;
const JOB_QUIET_FLOOR_MS = 10 * 60_000;
/** A run going longer than this has not returned. */
const JOB_HUNG_MS = 15 * 60_000;

export interface Problem {
  key: string;
  text: string;
  /** A trainer job's problem: notified, but not a stall of the alert path (no banner, no restart). */
  trainer?: boolean;
  /** The database's size: notified and failed like a trainer problem; nothing restarts for it. */
  capacity?: boolean;
  /**
   * A scanner job that runs but fails every run, or a side job (SIDE_JOBS) in trouble: notified
   * and failed like a trainer problem, with no banner and no restart - a restart does not mend an
   * upstream that is refusing every call, and the alerts themselves still flow.
   */
  side?: boolean;
  /** Pro trading's (the canary, trade outcomes): notified and failed like `side`, under its own heading. */
  trading?: boolean;
  /** A quiet flow a Helius credits outage explains (creditsOutFlows): `side`, plus its own banner. */
  creditsOut?: boolean;
}

/** The jobs the trainer process runs (see HEARTBEAT_JOB_ROLE), all watched from here. */
export const TRAINER_JOBS: HeartbeatJob[] = (Object.keys(HEARTBEAT_JOB_ROLE) as HeartbeatJob[]).filter(
  (job) => HEARTBEAT_JOB_ROLE[job] === "trainer",
);

export interface TrainerJobCheck {
  job: HeartbeatJob;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  /** The cadence an interval job reported (scheduler meta.intervalMs). */
  intervalMs: number | null;
  /** A daily job's slot (scheduler meta.dailyAtHourUtc). */
  dailyAtHourUtc: number | null;
  /**
   * When a run that was lost with its process started: a lock-guarded job (JOB_LOCKED_JOBS)
   * still stamped running with its lock free (heldJobLocks). Nothing else records such a run.
   */
  lostRunSince?: Date | null;
}

const HOUR_MS = 3_600_000;
/**
 * A daily job (cleanup, outcome-tracking) is overdue a day and three hours after its last run: the
 * slot's own run takes up to half an hour, and a boot's catch-up or a failed run's retries only
 * ever move the next run earlier.
 */
const TRAINER_DAILY_OVERDUE_MS = 27 * HOUR_MS;
/**
 * An interval job is overdue after two of its intervals plus this: room for one missed slot and
 * a long run (training's deadline is 90 minutes), so a deploy never reads as a stopped trainer.
 */
const TRAINER_INTERVAL_SLACK_MS = 2 * HOUR_MS;
/** Errors that say a person or a deploy cut the run, not that the job is failing. */
const BENIGN_TRAINER_ERRORS = [SHUTDOWN_INTERRUPTED_ERROR, STOPPED_ERROR];
const TRAINER_ERROR_LENGTH = 200;
/** A trainer interval job this frequent is reported failing only after FREQUENT_TRAINER_FAILING_MS. */
const FREQUENT_TRAINER_JOB_MS = 5 * 60_000;
const FREQUENT_TRAINER_FAILING_MS = 30 * 60_000;

/**
 * How long a trainer job may go without a run before it is called overdue, from the cadence its
 * own heartbeat reports. A row with neither (a run its deadline cut writes no cadence) gets the
 * daily figure: past every interval the trainer runs on by default, so the guess errs late.
 */
export function trainerOverdueAfterMs(j: Pick<TrainerJobCheck, "intervalMs" | "dailyAtHourUtc">): number {
  if (j.dailyAtHourUtc !== null || j.intervalMs === null || j.intervalMs <= 0)
    return TRAINER_DAILY_OVERDUE_MS;
  return 2 * j.intervalMs + TRAINER_INTERVAL_SLACK_MS;
}

/**
 * Pure: the trainer jobs that are overdue or whose last run failed. A skipped run (the AI judge
 * with no API key, "reviewer off") is a run, so a job that is off on purpose never alarms. A failed
 * run's key is the job's for an interval job, so a run of failures is one notice and its recovery
 * another; for a daily job it carries the run's day, so each night's failure (a cleanup stage that
 * failed while the rest ran, kept as lastError - PartialJobFailure) is told once, and only once.
 */
export function findTrainerProblems(jobs: TrainerJobCheck[], now: number): Problem[] {
  const out: Problem[] = [];
  for (const j of jobs) {
    if (j.lastRunAt === null) continue;
    const since = now - j.lastRunAt.getTime();
    if (since > trainerOverdueAfterMs(j)) {
      out.push({
        key: `job:${j.job}`,
        text: `Trainer job ${j.job}: no run for ${formatAge(since)}`,
        trainer: true,
      });
    }
    if (j.lostRunSince) {
      // Keyed by the run, so each lost run is told once.
      out.push({
        key: `lost:${j.job}@${j.lostRunSince.toISOString()}`,
        text: `Trainer job ${j.job}: the run started ${j.lostRunSince.toISOString().slice(11, 16)} UTC was lost with its process (out of memory or killed) - it runs again at its next slot`,
        trainer: true,
      });
    }
    const error = j.lastError;
    if (error === null || BENIGN_TRAINER_ERRORS.some((e) => error.startsWith(e))) continue;
    // A job that runs every few minutes (candle-peaks, label-regrade) is told about once its runs
    // have failed for a while, not on each failed run: one Pump.fun 429 was a notice and its
    // "flowing again" a minute later.
    if (
      j.dailyAtHourUtc === null &&
      j.intervalMs !== null &&
      j.intervalMs <= FREQUENT_TRAINER_JOB_MS &&
      j.lastSuccessAt !== null &&
      now - j.lastSuccessAt.getTime() <= FREQUENT_TRAINER_FAILING_MS
    ) {
      continue;
    }
    // A PartialJobFailure is recorded as a success, so its lastSuccessAt is the run's own time.
    const partial = j.lastSuccessAt !== null && j.lastSuccessAt.getTime() >= j.lastRunAt.getTime();
    const day = j.dailyAtHourUtc !== null ? `@${j.lastRunAt.toISOString().slice(0, 10)}` : "";
    const firstLine = (error.split("\n")[0] ?? "").slice(0, TRAINER_ERROR_LENGTH);
    out.push({
      key: `failed:${j.job}${day}`,
      text: `Trainer job ${j.job}: ${partial ? "last run partly failed" : "last run failed"}: ${firstLine}`,
      trainer: true,
    });
  }
  return out;
}

/** "50 min", or "27 h" once it is past two hours. */
function formatAge(ms: number): string {
  return ms < 2 * HOUR_MS ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / HOUR_MS)} h`;
}

/**
 * The keys that cleared, less a failed daily run's that a newer day's failure of the same job took
 * over: that one is not "flowing again", the new notice says what it is now.
 */
export function clearedKeys(before: Set<string>, now: Set<string>): string[] {
  const base = (key: string) => key.split("@")[0];
  const current = new Set([...now].map(base));
  return [...before].filter((k) => !now.has(k) && !(k.includes("@") && current.has(base(k))));
}

/**
 * Telegram delivery is behind when a linked chat's cursor (TelegramChat.sentThrough, which the
 * dispatcher moves to "now" on every pass, sent or not) is this old.
 */
const TELEGRAM_LAG_MS = 15 * 60_000;

/** Pure: which flows and jobs are stalled. `oldestChatCursor`: the furthest-behind enabled chat. */
export function findProblems(
  flows: FlowCheck[],
  jobs: JobCheck[],
  now: number,
  oldestChatCursor: Date | null = null,
): Problem[] {
  const out: Problem[] = [];
  if (oldestChatCursor !== null && now - oldestChatCursor.getTime() > TELEGRAM_LAG_MS) {
    const mins = Math.round((now - oldestChatCursor.getTime()) / 60_000);
    out.push({ key: "telegram", text: `Telegram alerts: a linked chat is ${mins} min behind` });
  }
  for (const f of flows) {
    if (f.recent === 0 && f.baseline > 0) {
      out.push({
        key: f.key,
        text: `${f.label}: none in the last ${f.windowMinutes} min (${f.baseline} in the day before)`,
      });
    }
  }
  for (const j of jobs) {
    if (j.lastRunAt === null) continue;
    if (j.runningSince !== null && now - j.runningSince.getTime() > JOB_HUNG_MS) {
      const mins = Math.round((now - j.runningSince.getTime()) / 60_000);
      out.push({ key: `job:${j.job}`, text: `Job ${j.job}: a run has not returned for ${mins} min` });
      continue;
    }
    const quietAfter = Math.max(JOB_QUIET_FLOOR_MS, (j.intervalMs ?? 0) * JOB_QUIET_INTERVALS);
    const since = now - j.lastRunAt.getTime();
    if (since > quietAfter) {
      out.push({
        key: `job:${j.job}`,
        text: `Job ${j.job}: no run for ${Math.round(since / 60_000)} min`,
      });
      continue;
    }
    const failing = failingProblem(j, now, quietAfter);
    if (failing) out.push(failing);
  }
  return out;
}

/** The key and text for a job that runs but has not succeeded for `afterMs`, or null. */
function failingProblem(j: JobCheck, now: number, afterMs: number): Problem | null {
  // Not read (undefined), or a success within the window.
  if (j.lastSuccessAt === undefined || j.lastRunAt === null) return null;
  if (j.lastSuccessAt !== null && now - j.lastSuccessAt.getTime() <= afterMs) return null;
  const forText =
    j.lastSuccessAt === null
      ? "every run has failed"
      : `every run failed for ${formatAge(now - j.lastSuccessAt.getTime())}`;
  const error = (j.lastError?.split("\n")[0] ?? "").slice(0, TRAINER_ERROR_LENGTH);
  return {
    key: `failing:${j.job}`,
    text: `Job ${j.job}: ${forText}${error ? `: ${error}` : ""}`,
    side: true,
  };
}

/**
 * Pure: the side jobs (SIDE_JOBS) that hang, have stopped, or fail every run - all notify-only
 * (`side`), keyed apart from the alert path's so they never start the restart clock.
 */
export function findSideJobProblems(jobs: JobCheck[], now: number): Problem[] {
  const out: Problem[] = [];
  for (const j of jobs) {
    if (j.lastRunAt === null) continue;
    const quietAfter = Math.max(JOB_QUIET_FLOOR_MS, (j.intervalMs ?? 0) * JOB_QUIET_INTERVALS);
    if (j.runningSince !== null && now - j.runningSince.getTime() > Math.max(JOB_HUNG_MS, quietAfter)) {
      out.push({
        key: `side:${j.job}`,
        text: `Job ${j.job}: a run has not returned for ${formatAge(now - j.runningSince.getTime())}`,
        side: true,
      });
      continue;
    }
    const since = now - j.lastRunAt.getTime();
    if (since > quietAfter) {
      out.push({ key: `side:${j.job}`, text: `Job ${j.job}: no run for ${formatAge(since)}`, side: true });
      continue;
    }
    const failing = failingProblem(j, now, quietAfter);
    if (failing) out.push(failing);
  }
  return out;
}

/**
 * The database against DB_DISK_ALERT_MB. One problem under a fixed key, so the admins hear once
 * when the line is crossed and once when the size is back under it, and the strict health check
 * fails in between (an external monitor's cue).
 */
export function findCapacityProblems(databaseBytes: number | null, alertMb: number): Problem[] {
  if (databaseBytes === null || !(alertMb > 0)) return [];
  const mb = databaseBytes / 1_048_576;
  if (mb < alertMb) return [];
  const gb = (n: number) => (n / 1024).toFixed(1);
  return [
    {
      key: "disk",
      text:
        `Database: ${gb(mb)} GB, past the ${gb(alertMb)} GB warning line (DB_DISK_ALERT_MB) - ` +
        "raise the Postgres disk on Render or free space before writes stop " +
        "(README: when the database disk is nearly full)",
      capacity: true,
    },
  ];
}

/**
 * Helius's credits used up, as this process heard it (apiUsage.ts stands its Helius calls down
 * meanwhile): wallet, linked, sniper and holder figures go unknown and the burn scan fails until
 * the plan is topped up. Notified like a failing side job; a restart would not mend it.
 */
export function findCreditProblems(out: { since: Date; until: Date } | null): Problem[] {
  if (!out) return [];
  return [
    {
      key: "helius-credits",
      text:
        `Helius credits used up since ${out.since.toISOString().slice(11, 16)} UTC ("max usage reached") - ` +
        "Helius calls stand down 15 minutes at a time until the plan is topped up or autoscaling is on",
      side: true,
    },
  ];
}

/**
 * How long after a Helius stand-down a quiet flow is still put down to it, at the least: a flow is
 * judged over its own window (FLOW_WINDOWS_MINUTES), so one whose window reaches back into the
 * outage is the outage's for that long.
 */
export const CREDITS_OUT_FLOW_GRACE_MS = 15 * 60_000;
const CREDITS_OUT_FLOW_NOTE = " - Helius credits exhausted";

/**
 * Pure: the quiet flows a Helius credits outage explains, made notify-only (`side`). While credits
 * are out the screen fails closed on every new coin, so decisions and model alerts read zero; that
 * counted as a stall, and the watcher put up "part of the scanner has stalled" and restarted the
 * scanner, which mends nothing (audit 2026-10-22, H4). `outAt(t)` says whether credits were out at
 * any time after `t` (heliusCreditsOut(t) !== null).
 */
export function creditsOutFlows(problems: Problem[], outAt: (t: number) => boolean, now: number): Problem[] {
  const windows = FLOW_WINDOWS_MINUTES as Record<string, number>;
  return problems.map((p) => {
    const window = windows[p.key];
    if (window === undefined || p.side) return p;
    if (!outAt(now - Math.max(CREDITS_OUT_FLOW_GRACE_MS, window * 60_000))) return p;
    return { ...p, text: `${p.text}${CREDITS_OUT_FLOW_NOTE}`, side: true, creditsOut: true };
  });
}

/** What the trade canary's own heartbeat says (tradeCanaryJob.ts). */
export interface CanaryCheck {
  lastRunAt: Date | null;
  /** Failed runs in a row, as the canary counted them (its meta.consecutiveFailures). */
  consecutiveFailures: number;
  lastError: string | null;
}

/** The canary is told about after this many failed runs in a row: one slow answer is not a page. */
export const CANARY_ALERT_AFTER_FAILURES = 2;
/**
 * The canary is quiet after this long without a run: three of its intervals, and never under the
 * 25 minutes that were five of its old 5-minute intervals. Scaled to TRADE_CANARY_INTERVAL_MINUTES
 * (user ask 2026-10-23: API audit bundle): a fixed 25 minutes would call a healthy 15-minute
 * canary that is one run late "no run".
 */
export function canaryQuietMs(intervalMinutes: number): number {
  return Math.max(25 * 60_000, 3 * intervalMinutes * 60_000);
}

/**
 * Pure: the trade canary failing run after run, or no longer running. One key for both, so the
 * admins hear once when it starts and once when it clears. A canary that never ran (switched off,
 * or not deployed here) is not judged.
 */
export function findCanaryProblems(c: CanaryCheck | null, now: number, intervalMinutes: number): Problem[] {
  if (!c || c.lastRunAt === null) return [];
  const since = now - c.lastRunAt.getTime();
  if (since > canaryQuietMs(intervalMinutes)) {
    return [
      {
        key: "trade-canary",
        text: `Pro trade canary: no run for ${formatAge(since)}`,
        side: true,
        trading: true,
      },
    ];
  }
  if (c.consecutiveFailures < CANARY_ALERT_AFTER_FAILURES) return [];
  const error = (c.lastError?.split("\n")[0] ?? "").replace(/^trade canary: /, "").slice(0, 300);
  return [
    {
      key: "trade-canary",
      text: `Pro trade canary: ${c.consecutiveFailures} runs failed in a row${error ? `: ${error}` : ""}`,
      side: true,
      trading: true,
    },
  ];
}

/** The window the Pro trades' outcomes are judged over, and the fewest trades worth judging. */
export const TRADE_OUTCOME_WINDOW_MINUTES = 30;
export const TRADE_OUTCOME_MIN_TRADES = 5;
/** More than this share of the window's trades failed or expired is a problem. */
export const TRADE_OUTCOME_MAX_BAD_SHARE = 0.3;

/** The Pro trades sent in the window (PlatformTrade.sentAt), and how many failed or expired. */
export interface TradeOutcomeCheck {
  total: number;
  failed: number;
  expired: number;
}

/**
 * Pure: too many of the window's Pro trades failed or expired. Trades still in flight count in
 * the total, so a burst of sends errs quiet, never loud.
 */
export function findTradeOutcomeProblems(t: TradeOutcomeCheck): Problem[] {
  if (t.total < TRADE_OUTCOME_MIN_TRADES) return [];
  const bad = t.failed + t.expired;
  if (bad / t.total <= TRADE_OUTCOME_MAX_BAD_SHARE) return [];
  return [
    {
      key: "trade-outcomes",
      text:
        `Pro trades: ${bad} of ${t.total} in the last ${TRADE_OUTCOME_WINDOW_MINUTES} min failed or expired ` +
        `(${t.failed} failed, ${t.expired} expired)`,
      side: true,
      trading: true,
    },
  ];
}

/** pg_database_size, in bytes; null when the read fails (the other checks still run). */
async function databaseBytes(): Promise<number | null> {
  try {
    const [row] = await prisma.$queryRaw<{ bytes: bigint }[]>`
      SELECT pg_database_size(current_database()) AS bytes`;
    return row ? Number(row.bytes) : null;
  } catch (err) {
    logger.warn("database size not read", { error: String(err) });
    return null;
  }
}

async function countFlows(now: number): Promise<FlowCheck[]> {
  const DAY = 24 * 3_600_000;
  const out: FlowCheck[] = [];
  for (const key of Object.keys(FLOW_WINDOWS_MINUTES) as (keyof typeof FLOW_WINDOWS_MINUTES)[]) {
    const windowMinutes = FLOW_WINDOWS_MINUTES[key];
    const start = new Date(now - windowMinutes * 60_000);
    const dayStart = new Date(start.getTime() - DAY);
    const count = (from: Date, to: Date): Promise<number> => {
      switch (key) {
        case "discovery":
          return prisma.token.count({ where: { firstSeenAt: { gte: from, lt: to } } });
        case "decisions":
          return prisma.candidateOutcome.count({
            where: { sampleKind: "event", anchorAt: { gte: from, lt: to } },
          });
        case "tokensage":
          return prisma.tokenNarrative.count({ where: { checkedAt: { gte: from, lt: to } } });
        case "modelAlerts":
          return prisma.curatedAlert.count({ where: { createdAt: { gte: from, lt: to } } });
      }
    };
    const [recent, baseline] = await Promise.all([count(start, new Date(now)), count(dayStart, start)]);
    out.push({ key, label: FLOW_LABELS[key], windowMinutes, recent, baseline });
  }
  return out;
}

async function readJobs(jobs: HeartbeatJob[]): Promise<JobCheck[]> {
  const rows = await prisma.systemHeartbeat.findMany({ where: { job: { in: jobs } } });
  return jobs.map((job) => {
    const row = rows.find((r) => r.job === job);
    const meta = (row?.meta ?? null) as Record<string, unknown> | null;
    const interval = meta && typeof meta.intervalMs === "number" ? meta.intervalMs : null;
    return {
      job,
      lastRunAt: row?.lastRunAt ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastError: row?.lastError ?? null,
      intervalMs: interval,
      runningSince: runningSinceFrom(row?.meta, row?.lastRunAt),
    };
  });
}

/** How long after its start a lock-guarded run must be lockless to count as lost (see health.ts). */
const LOST_RUN_GRACE_MS = 2 * 60_000;

async function readTrainerJobs(now: number): Promise<TrainerJobCheck[]> {
  const [rows, held] = await Promise.all([
    prisma.systemHeartbeat.findMany({ where: { job: { in: TRAINER_JOBS } } }),
    heldJobLocks(),
  ]);
  return TRAINER_JOBS.map((job) => {
    const row = rows.find((r) => r.job === job);
    const meta = (row?.meta ?? null) as Record<string, unknown> | null;
    const num = (k: string) => (meta && typeof meta[k] === "number" ? (meta[k] as number) : null);
    const since = runningSinceFrom(row?.meta, row?.lastRunAt);
    const lost =
      held !== null &&
      since !== null &&
      JOB_LOCKED_JOBS.includes(job) &&
      now - since.getTime() > LOST_RUN_GRACE_MS &&
      !held.has(job) &&
      // Still going after its lock's connection dropped (jobLock.ts): not lost.
      !lockLostDuringRun(row?.meta, since);
    return {
      lostRunSince: lost ? since : null,
      job,
      lastRunAt: row?.lastRunAt ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastError: row?.lastError ?? null,
      intervalMs: num("intervalMs"),
      dailyAtHourUtc: num("dailyAtHourUtc"),
    };
  });
}

async function readCanary(): Promise<CanaryCheck | null> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job: "trade-canary" } });
  if (!row) return null;
  const meta = (row.meta ?? null) as Record<string, unknown> | null;
  const n = meta?.consecutiveFailures;
  return {
    lastRunAt: row.lastRunAt,
    // A failed run that left no count of its own still counts as one.
    consecutiveFailures:
      typeof n === "number" ? n : row.lastSuccessAt && row.lastSuccessAt >= row.lastRunAt ? 0 : 1,
    lastError: row.lastError,
  };
}

async function countTradeOutcomes(now: number): Promise<TradeOutcomeCheck> {
  const rows = await prisma.platformTrade.groupBy({
    by: ["status"],
    where: { sentAt: { gte: new Date(now - TRADE_OUTCOME_WINDOW_MINUTES * 60_000) } },
    _count: { _all: true },
  });
  const of = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
  return { total: rows.reduce((n, r) => n + r._count._all, 0), failed: of("failed"), expired: of("expired") };
}

async function oldestChatCursor(): Promise<Date | null> {
  const row = await prisma.telegramChat.findFirst({
    where: { enabled: true, revokedAt: null },
    orderBy: { sentThrough: "asc" },
    select: { sentThrough: true },
  });
  return row?.sentThrough ?? null;
}

/** What the last run left on this job's own heartbeat: the stall in progress and the restart state. */
interface WatchState {
  keys: Set<string>;
  /** When the unbroken stall in progress began. */
  stalledSince: number | null;
  /** 0 none, 1 the 5-minute warning is up, 2 the 1-minute warning is up (restart due), -1 restart capped. */
  warned: number;
  lastRestartAt: number | null;
  /** The Helius plan's cycle so far (heliusBudget.ts); null with the alarm off. */
  heliusPlan: HeliusPlanState | null;
}

async function previousState(): Promise<WatchState> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job: "pipeline-watch" } });
  const meta = (row?.meta ?? null) as Record<string, unknown> | null;
  const str = (k: string) => (meta && typeof meta[k] === "string" ? (meta[k] as string) : "");
  const time = (k: string) => {
    const t = Date.parse(str(k));
    return Number.isNaN(t) ? null : t;
  };
  return {
    keys: new Set(str("stalledKeys").split(",").filter(Boolean)),
    stalledSince: time("stalledSince"),
    warned: meta && typeof meta.warned === "number" ? meta.warned : 0,
    lastRestartAt: time("lastRestartAt"),
    heliusPlan: readPlanState(meta?.heliusPlan),
  };
}

/**
 * The admin wallets' own private Telegram chats (kind "private"): never a group or channel an
 * admin linked, whose other members shouldn't get operator notices (user decision 2026-10-08).
 */
async function adminChats(env: Env): Promise<bigint[]> {
  const admins = [...adminWalletSet(env)];
  if (admins.length === 0) return [];
  const chats = await prisma.telegramChat.findMany({
    where: { enabled: true, revokedAt: null, kind: "private", user: { walletAddress: { in: admins } } },
    select: { chatId: true },
  });
  return chats.map((c) => c.chatId);
}

export function notificationText(started: Problem[], cleared: string[], still: Problem[]): string {
  const lines: string[] = [];
  const stalled = started.filter((p) => !p.trainer && !p.capacity && !p.side);
  const side = started.filter((p) => p.side && !p.trading);
  const trading = started.filter((p) => p.trading);
  const trainer = started.filter((p) => p.trainer);
  const capacity = started.filter((p) => p.capacity);
  if (stalled.length > 0) {
    lines.push("<b>⚠️ TrenchScanner pipeline stalled</b>");
    for (const p of stalled) lines.push(`• ${escapeHtml(p.text)}`);
  }
  if (side.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("<b>⚠️ TrenchScanner scanner jobs need a look</b>");
    for (const p of side) lines.push(`• ${escapeHtml(p.text)}`);
  }
  if (trading.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("<b>⚠️ TrenchScanner Pro trading needs a look</b>");
    for (const p of trading) lines.push(`• ${escapeHtml(p.text)}`);
  }
  if (trainer.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("<b>⚠️ TrenchScanner trainer needs a look</b>");
    for (const p of trainer) lines.push(`• ${escapeHtml(p.text)}`);
  }
  if (capacity.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("<b>⚠️ TrenchScanner database is filling up</b>");
    for (const p of capacity) lines.push(`• ${escapeHtml(p.text)}`);
  }
  if (cleared.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`<b>✅ Flowing again:</b> ${escapeHtml(cleared.join(", "))}`);
  }
  const others = still.filter((p) => !started.some((s) => s.key === p.key));
  if (others.length > 0) {
    lines.push("");
    lines.push(`Still stalled: ${escapeHtml(others.map((p) => p.key).join(", "))}`);
  }
  return lines.join("\n");
}

/**
 * Self-healing (user decision 2026-10-08): a stall that lasts RESTART_AFTER_MS restarts the
 * scanner process, at most once per RESTART_MIN_GAP_MS. Today's stall was in-process state (a
 * request that never returned) that only a restart cleared. Visitors get a banner 5 minutes and
 * 1 minute before; the admins get a DM. A stall a restart doesn't clear (an upstream outage)
 * only notifies until the hour is up.
 */
export const RESTART_AFTER_MS = 10 * 60_000;
export const RESTART_MIN_GAP_MS = 60 * 60_000;
const FIRST_WARNING_AT_MS = RESTART_AFTER_MS - 5 * 60_000;
const LAST_WARNING_AT_MS = RESTART_AFTER_MS - 60_000;
const RESTART_DELAY_MS = 60_000;
/** Who the automatic banners are posted as, so ending them never ends an admin's own. */
export const WATCH_ANNOUNCER = "pipeline-watch";

export type RestartStep = "none" | "warn5" | "warn1" | "capped";

/** Pure: what to do about a stall `stallMs` old, given the warnings already up and the last restart. */
export function restartStep(
  stallMs: number | null,
  warned: number,
  lastRestartAt: number | null,
  now: number,
): RestartStep {
  if (stallMs === null || stallMs < FIRST_WARNING_AT_MS || warned === -1) return "none";
  // The restart is on its way (or the fresh process is still starting up).
  if (warned >= 2 && lastRestartAt !== null && now < lastRestartAt + 2 * 60_000) return "none";
  // Restarted within the hour (or the stall outlived the restart): notify, don't restart again.
  if (lastRestartAt !== null && now - lastRestartAt < RESTART_MIN_GAP_MS) return "capped";
  if (stallMs >= LAST_WARNING_AT_MS) return "warn1";
  return warned >= 1 ? "none" : "warn5";
}

/** The visitors' banner while a Helius credits outage holds alerts back: the cause, not a stall. */
export const CREDITS_OUT_BANNER =
  "Alerts are paused: Helius credits exhausted (our chain-data provider). They resume on their own once the plan is topped up.";

const BANNER: Record<"warn5" | "warn1", string> = {
  warn5:
    "Alerts are delayed: part of the scanner has stalled. If it doesn't recover, it restarts automatically in about 5 minutes, and alerts pause for a minute or two.",
  warn1: "The scanner restarts in about a minute to clear a stall. Alerts pause for a minute or two.",
};

/** Puts the credits-out banner up while `on` (again once one expires), and ends it when not. */
async function creditsOutBanner(on: boolean, now: number): Promise<void> {
  const open = { createdBy: WATCH_ANNOUNCER, message: CREDITS_OUT_BANNER, endedAt: null };
  if (!on) {
    await prisma.announcement.updateMany({ where: open, data: { endedAt: new Date(now) } });
    return;
  }
  const up = await prisma.announcement.findFirst({
    where: { ...open, expiresAt: { gt: new Date(now) } },
    select: { id: true },
  });
  if (!up) await postBanner(CREDITS_OUT_BANNER, now);
}

async function postBanner(message: string, now: number): Promise<void> {
  await prisma.announcement.create({
    data: {
      message,
      severity: "warning",
      expiresAt: new Date(now + 15 * 60_000),
      createdBy: WATCH_ANNOUNCER,
    },
  });
}

async function endBanners(now: number): Promise<void> {
  await prisma.announcement.updateMany({
    where: { createdBy: WATCH_ANNOUNCER, endedAt: null },
    data: { endedAt: new Date(now) },
  });
}

/**
 * Through the worker's graceful shutdown (processExit.ts), so the runs still in flight - the
 * stalled one included, bounded by the shutdown's grace - are settled or marked interrupted
 * rather than cut mid-write.
 */
function restartForStall(): void {
  const timer = setTimeout(() => {
    logger.error("restarting the scanner to clear a pipeline stall");
    exitForRestart({ reason: "pipeline stall" });
  }, RESTART_DELAY_MS);
  // Kept referenced: the restart must happen even if nothing else is scheduled.
  void timer;
}

export interface PipelineWatchDeps {
  telegram?: Pick<TelegramApi, "sendMessage">;
  now?: number;
  /** Ends the process after RESTART_DELAY_MS so the platform starts a fresh one. */
  restart?: () => void;
}

/** The stall state as stored on the heartbeat row, read back by previousState. */
function stateMeta(state: WatchState): JobRunMeta {
  return {
    stalledKeys: [...state.keys].join(","),
    stalledSince: state.stalledSince === null ? null : new Date(state.stalledSince).toISOString(),
    warned: state.warned,
    lastRestartAt: state.lastRestartAt === null ? null : new Date(state.lastRestartAt).toISOString(),
    heliusPlan: state.heliusPlan,
  };
}

export async function runPipelineWatch(env: Env, deps: PipelineWatchDeps = {}): Promise<JobRunMeta> {
  // The stall state lives only on this job's heartbeat row, and the scheduler replaces that row's
  // meta on any error that is not a JobFailure. So an ordinary error (a pool timeout mid-run) used
  // to wipe it: the next run re-sent every "stalled" notice, restarted the stall clock, and forgot
  // lastRestartAt - letting the next process restart again inside the hourly cap. Any error is
  // rethrown as a JobFailure carrying the newest state known.
  let known: WatchState | null = null;
  try {
    return await watchOnce(env, deps, (state) => {
      known = state;
    });
  } catch (err) {
    if (err instanceof JobFailure || known === null) throw err;
    throw new JobFailure(String(err), stateMeta(known));
  }
}

/** How long past a Helius stand-down's end it still counts as out, for the alert (see watchOnce). */
const CREDITS_OUT_CLEAR_GRACE_MS = 2 * 60_000;

async function watchOnce(
  env: Env,
  deps: PipelineWatchDeps,
  remember: (state: WatchState) => void,
): Promise<JobRunMeta> {
  const now = deps.now ?? Date.now();
  const before = await previousState();
  remember(before);
  // The Helius plan against its cycle (HELIUS_MONTHLY_CREDITS): read about once an hour, notified
  // once per threshold a cycle. A failed read keeps the last state and judges nothing new.
  let heliusPlan = before.heliusPlan;
  let planNotices: string[] = [];
  try {
    ({ state: heliusPlan, notices: planNotices } = await checkHeliusPlan(env, before.heliusPlan, now));
  } catch (err) {
    logger.warn("Helius plan not read", { error: String(err) });
  }
  // Still out for a short while past the stand-down's end: it lifts at a fixed time and is only set
  // again by the next billed call refused, so a run in that gap read "flowing again" every cycle.
  const creditsOut = heliusCreditsOut(now - CREDITS_OUT_CLEAR_GRACE_MS);
  const [flows, jobs, sideJobs, trainerJobs, cursor, dbBytes, canary, trades] = await Promise.all([
    countFlows(now),
    readJobs(WATCHED_JOBS),
    readJobs(SIDE_JOBS),
    readTrainerJobs(now),
    oldestChatCursor(),
    databaseBytes(),
    // A canary switched off leaves its last row behind; it is not judged then.
    env.TRADE_CANARY_ENABLED ? readCanary() : Promise.resolve(null),
    countTradeOutcomes(now),
  ]);
  const problems = [
    ...creditsOutFlows(findProblems(flows, jobs, now, cursor), (t) => heliusCreditsOut(t) !== null, now),
    ...findSideJobProblems(sideJobs, now),
    ...findTrainerProblems(trainerJobs, now),
    ...findCapacityProblems(dbBytes, env.DB_DISK_ALERT_MB),
    ...findCreditProblems(creditsOut),
    ...findCanaryProblems(canary, now, env.TRADE_CANARY_INTERVAL_MINUTES),
    ...findTradeOutcomeProblems(trades),
  ];
  // Only the alert path's own problems are a stall: they alone start the clock towards the
  // visitors' banner and the scanner restart, neither of which a trainer job's problem or a
  // filling disk calls for.
  const stalls = problems.filter((p) => !p.trainer && !p.capacity && !p.side);
  const keys = new Set(problems.map((p) => p.key));
  const started = problems.filter((p) => !before.keys.has(p.key));
  const cleared = clearedKeys(before.keys, keys);
  const stalledSince = stalls.length === 0 ? null : (before.stalledSince ?? now);
  let warned = stalls.length === 0 ? 0 : before.warned;
  let lastRestartAt = before.lastRestartAt;

  const notices: string[] = [...planNotices];
  if (started.length > 0 || cleared.length > 0) notices.push(notificationText(started, cleared, problems));
  if (stalls.length === 0 && before.stalledSince !== null) await endBanners(now);
  await creditsOutBanner(
    problems.some((p) => p.creditsOut),
    now,
  );

  // From here on a failure keeps this run's warning level and any restart it scheduled. The
  // stalled keys stay the previous run's until the notices go out, so a failed send is retried.
  remember({ keys: before.keys, stalledSince, warned, lastRestartAt, heliusPlan });
  const step = restartStep(stalledSince === null ? null : now - stalledSince, warned, lastRestartAt, now);
  if (step === "warn5" || step === "warn1") {
    warned = step === "warn5" ? 1 : 2;
    if (step === "warn1") {
      lastRestartAt = now + RESTART_DELAY_MS;
      notices.push("<b>🔄 Restarting the scanner in about a minute</b> to clear the stall.");
      (deps.restart ?? restartForStall)();
    }
    remember({ keys: before.keys, stalledSince, warned, lastRestartAt, heliusPlan });
    await postBanner(BANNER[step], now);
  } else if (step === "capped") {
    warned = -1;
    remember({ keys: before.keys, stalledSince, warned, lastRestartAt, heliusPlan });
    notices.push(
      "<b>Not restarting:</b> the scanner already restarted in the last hour, so this stall needs a look.",
    );
  }

  let notified = 0;
  if (notices.length > 0 && (deps.telegram || env.TELEGRAM_BOT_TOKEN)) {
    const api = deps.telegram ?? new TelegramApi(env.TELEGRAM_BOT_TOKEN);
    for (const chatId of await adminChats(env)) {
      const res = await api.sendMessage(chatId, notices.join("\n\n"));
      if (res.ok) notified += 1;
      else logger.warn("pipeline notice not sent", { code: res.code });
    }
  }

  const meta: JobRunMeta = {
    stalled: problems.length,
    notified,
    stalledKeys: [...keys].join(","),
    stalledSince: stalledSince === null ? null : new Date(stalledSince).toISOString(),
    warned,
    lastRestartAt: lastRestartAt === null ? null : new Date(lastRestartAt).toISOString(),
    databaseMb: dbBytes === null ? null : Math.round(dbBytes / 1_048_576),
    heliusCreditsOutUntil: creditsOut ? creditsOut.until.toISOString() : null,
    heliusPlan,
    flows: Object.fromEntries(flows.map((f) => [f.key, f.recent])),
    tradeOutcomes: { ...trades },
  };
  if (problems.length > 0) {
    logger.error("pipeline stalled", { problems: problems.map((p) => p.text) });
    throw new JobFailure(problems.map((p) => p.text).join("; "), meta);
  }
  return meta;
}
