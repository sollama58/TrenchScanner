import {
  prisma,
  adminWalletSet,
  createLogger,
  escapeHtml,
  runningSinceFrom,
  TelegramApi,
  type Env,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { JobFailure, type JobRunMeta } from "../scheduler.js";

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
/** A job is quiet after this many of its own intervals without a run, and never sooner than the floor. */
const JOB_QUIET_INTERVALS = 5;
const JOB_QUIET_FLOOR_MS = 10 * 60_000;
/** A run going longer than this has not returned. */
const JOB_HUNG_MS = 15 * 60_000;

export interface Problem {
  key: string;
  text: string;
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
    }
  }
  return out;
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

async function readJobs(): Promise<JobCheck[]> {
  const rows = await prisma.systemHeartbeat.findMany({ where: { job: { in: WATCHED_JOBS } } });
  return WATCHED_JOBS.map((job) => {
    const row = rows.find((r) => r.job === job);
    const meta = (row?.meta ?? null) as Record<string, unknown> | null;
    const interval = meta && typeof meta.intervalMs === "number" ? meta.intervalMs : null;
    return {
      job,
      lastRunAt: row?.lastRunAt ?? null,
      intervalMs: interval,
      runningSince: runningSinceFrom(row?.meta),
    };
  });
}

async function oldestChatCursor(): Promise<Date | null> {
  const row = await prisma.telegramChat.findFirst({
    where: { enabled: true, revokedAt: null },
    orderBy: { sentThrough: "asc" },
    select: { sentThrough: true },
  });
  return row?.sentThrough ?? null;
}

/** What the last run flagged, read back from this job's own heartbeat. */
async function previousKeys(): Promise<Set<string>> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job: "pipeline-watch" } });
  const meta = (row?.meta ?? null) as Record<string, unknown> | null;
  const raw = meta && typeof meta.stalledKeys === "string" ? meta.stalledKeys : "";
  return new Set(raw.split(",").filter(Boolean));
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
  if (started.length > 0) {
    lines.push("<b>⚠️ TrenchScanner pipeline stalled</b>");
    for (const p of started) lines.push(`• ${escapeHtml(p.text)}`);
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

export interface PipelineWatchDeps {
  telegram?: Pick<TelegramApi, "sendMessage">;
  now?: number;
}

export async function runPipelineWatch(env: Env, deps: PipelineWatchDeps = {}): Promise<JobRunMeta> {
  const now = deps.now ?? Date.now();
  const [flows, jobs, before, cursor] = await Promise.all([
    countFlows(now),
    readJobs(),
    previousKeys(),
    oldestChatCursor(),
  ]);
  const problems = findProblems(flows, jobs, now, cursor);
  const keys = new Set(problems.map((p) => p.key));
  const started = problems.filter((p) => !before.has(p.key));
  const cleared = [...before].filter((k) => !keys.has(k));

  let notified = 0;
  if ((started.length > 0 || cleared.length > 0) && (deps.telegram || env.TELEGRAM_BOT_TOKEN)) {
    const api = deps.telegram ?? new TelegramApi(env.TELEGRAM_BOT_TOKEN);
    const text = notificationText(started, cleared, problems);
    for (const chatId of await adminChats(env)) {
      const res = await api.sendMessage(chatId, text);
      if (res.ok) notified += 1;
      else logger.warn("pipeline notice not sent", { code: res.code });
    }
  }

  const meta: JobRunMeta = {
    stalled: problems.length,
    notified,
    stalledKeys: [...keys].join(","),
    flows: Object.fromEntries(flows.map((f) => [f.key, f.recent])),
  };
  if (problems.length > 0) {
    logger.error("pipeline stalled", { problems: problems.map((p) => p.text) });
    throw new JobFailure(problems.map((p) => p.text).join("; "), meta);
  }
  return meta;
}
