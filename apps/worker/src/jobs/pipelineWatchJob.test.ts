// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHeliusCreditsOut, meteredFetch, prisma, loadEnv, type Env } from "@trenchscanner/core";
import { JobFailure, SHUTDOWN_INTERRUPTED_ERROR } from "../scheduler.js";
import {
  AGED_OUT_QUIET_MS,
  clearedKeys,
  CREDITS_OUT_BANNER,
  decidedMs,
  findAgedOutProblems,
  findDisabledChatProblems,
  findScanLatencyProblems,
  findTrainingRunProblems,
  SCAN_LATENCY_SAMPLES,
  TELEGRAM_LAG_MS,
  creditsOutFlows,
  canaryQuietMs,
  findCanaryProblems,
  findCapacityProblems,
  findCreditProblems,
  findProblems,
  findSideJobProblems,
  findTradeOutcomeProblems,
  findTrainerProblems,
  notificationText,
  restartStep,
  runPipelineWatch,
  SIDE_JOBS,
  TRAINER_JOBS,
  trainerOverdueAfterMs,
  WATCH_ANNOUNCER,
  WATCHED_JOBS,
  type FlowCheck,
  type TrainerJobCheck,
  findTelegramHoldProblems,
  TELEGRAM_HOLD_ALERT_MS,
} from "./pipelineWatchJob.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 8, 13, 30);

const flow = (key: string, recent: number, baseline: number): FlowCheck => ({
  key,
  label: key,
  windowMinutes: 15,
  recent,
  baseline,
});

describe("pipeline watch: what counts as stalled", () => {
  it("flags a flow that produced nothing in its window but did the day before", () => {
    const problems = findProblems([flow("tokensage", 0, 4_000), flow("decisions", 12, 900)], [], NOW);
    expect(problems.map((p) => p.key)).toEqual(["tokensage"]);
  });

  it("leaves a flow that isn't in use alone", () => {
    expect(findProblems([flow("tokensage", 0, 0)], [], NOW)).toEqual([]);
  });

  it("flags an alert-path job that stopped running or whose run never returned", () => {
    const problems = findProblems(
      [],
      [
        { job: "scan", lastRunAt: new Date(NOW - 30 * MIN), intervalMs: 30_000, runningSince: null },
        { job: "fast-match", lastRunAt: new Date(NOW - MIN), intervalMs: 15_000, runningSince: null },
        {
          job: "telegram-dispatch",
          lastRunAt: new Date(NOW - MIN),
          intervalMs: 10_000,
          runningSince: new Date(NOW - 20 * MIN),
        },
        // Never ran (not deployed here): nothing to judge.
        { job: "candidate-watch", lastRunAt: null, intervalMs: null, runningSince: null },
      ],
      NOW,
    );
    expect(problems.map((p) => p.key)).toEqual(["job:scan", "job:telegram-dispatch"]);
  });

  it("tells the admins about an alert-path job that runs but fails every run, without a banner or restart", () => {
    const problems = findProblems(
      [],
      [
        {
          job: "scan",
          lastRunAt: new Date(NOW - MIN),
          lastSuccessAt: new Date(NOW - 40 * MIN),
          lastError: "pool timeout\nstack",
          intervalMs: 30_000,
          runningSince: null,
        },
        // A failure inside the window: one bad run, not a failing job.
        {
          job: "fast-match",
          lastRunAt: new Date(NOW - MIN),
          lastSuccessAt: new Date(NOW - 3 * MIN),
          lastError: "429",
          intervalMs: 15_000,
          runningSince: null,
        },
        // Never succeeded.
        {
          job: "telegram-dispatch",
          lastRunAt: new Date(NOW - MIN),
          lastSuccessAt: null,
          lastError: "every Telegram send failed (3 of 3 this pass)",
          intervalMs: 10_000,
          runningSince: null,
        },
      ],
      NOW,
    );
    expect(problems.map((p) => p.key)).toEqual(["failing:scan", "failing:telegram-dispatch"]);
    expect(problems.every((p) => p.side)).toBe(true);
    expect(problems[0]!.text).toBe("Job scan: every run failed for 40 min: pool timeout");
    expect(notificationText(problems, [], problems)).toContain("scanner jobs need a look");
    expect(notificationText(problems, [], problems)).not.toContain("pipeline stalled");
  });

  it("watches burn-scan and live-price: hung, stopped or failing, notify-only", () => {
    expect(SIDE_JOBS).toEqual(["burn-scan", "live-price"]);
    const problems = findSideJobProblems(
      [
        {
          job: "burn-scan",
          lastRunAt: new Date(NOW - 50 * MIN),
          lastSuccessAt: new Date(NOW - 50 * MIN),
          intervalMs: 2 * MIN,
          runningSince: new Date(NOW - 50 * MIN),
        },
        {
          job: "live-price",
          lastRunAt: new Date(NOW - MIN),
          lastSuccessAt: new Date(NOW - 30 * MIN),
          lastError: "every DexScreener batch failed (40 mints)",
          intervalMs: MIN,
          runningSince: null,
        },
      ],
      NOW,
    );
    expect(problems.map((p) => p.key)).toEqual(["side:burn-scan", "failing:live-price"]);
    expect(problems[0]!.text).toBe("Job burn-scan: a run has not returned for 50 min");
    expect(problems.every((p) => p.side && !p.trainer)).toBe(true);
    // Healthy: nothing.
    expect(
      findSideJobProblems(
        [
          {
            job: "live-price",
            lastRunAt: new Date(NOW - MIN),
            lastSuccessAt: new Date(NOW - MIN),
            intervalMs: MIN,
            runningSince: null,
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("flags Helius's credits running out, without a restart or banner", () => {
    expect(findCreditProblems(null)).toEqual([]);
    const out = findCreditProblems({
      since: new Date("2026-10-19T04:05:00Z"),
      until: new Date("2026-10-19T04:20:00Z"),
    });
    expect(out.map((p) => p.key)).toEqual(["helius-credits"]);
    expect(out[0]!.side).toBe(true);
    expect(out[0]!.text).toContain("Helius credits used up since 04:05 UTC");
    expect(notificationText(out, [], out)).toMatch(/^<b>⚠️ TrenchScanner scanner jobs need a look<\/b>/);
  });

  it("puts quiet flows down to a Helius credits outage in or near their window, not to a stall", () => {
    const quiet = findProblems(
      [flow("decisions", 0, 40), flow("modelAlerts", 0, 9), flow("other", 0, 5)],
      [],
      NOW,
    );
    // Out until 20 minutes ago: within the model alerts' 90-minute window and the 15-minute grace.
    const outUntil = NOW - 20 * MIN;
    const marked = creditsOutFlows(quiet, (t) => t < outUntil, NOW);
    expect(marked.map((p) => [p.key, !!p.side, !!p.creditsOut])).toEqual([
      ["decisions", true, true],
      ["modelAlerts", true, true],
      ["other", false, false],
    ]);
    expect(marked[0]!.text).toContain("Helius credits exhausted");
    // Out until 40 minutes ago: past the decisions' 30-minute window, inside the alerts' 90.
    const later = creditsOutFlows(quiet, (t) => t < NOW - 40 * MIN, NOW);
    expect(later.map((p) => !!p.side)).toEqual([false, true, false]);
    expect(creditsOutFlows(quiet, () => false, NOW)).toEqual(quiet);
  });

  it("flags the database once it passes the disk warning line, and not with the check off", () => {
    const gb = 1_073_741_824;
    expect(findCapacityProblems(11.5 * gb, 12_000)).toEqual([]);
    const over = findCapacityProblems(12.4 * gb, 12_000);
    expect(over.map((p) => p.key)).toEqual(["disk"]);
    expect(over[0]!.capacity).toBe(true);
    expect(over[0]!.text).toContain("Database: 12.4 GB, past the 11.7 GB warning line");
    expect(findCapacityProblems(12.4 * gb, 0)).toEqual([]);
    expect(findCapacityProblems(null, 12_000)).toEqual([]);
    const text = notificationText(over, [], over);
    expect(text).toMatch(/^<b>⚠️ TrenchScanner database is filling up<\/b>\n• Database: 12\.4 GB/);
    expect(text).not.toContain("pipeline stalled");
  });

  it("tells the trade canary after two failed runs in a row, or once it stops running", () => {
    const canary = (failures: number, agoMs = MIN, lastError: string | null = null) => ({
      lastRunAt: new Date(NOW - agoMs),
      consecutiveFailures: failures,
      lastError,
    });
    // Never ran (switched off, not deployed), healthy, or one failure: nothing to tell.
    expect(findCanaryProblems(null, NOW, 15)).toEqual([]);
    expect(findCanaryProblems(canary(0), NOW, 15)).toEqual([]);
    expect(findCanaryProblems(canary(1, MIN, "trade canary: sender: 503"), NOW, 15)).toEqual([]);
    const out = findCanaryProblems(canary(2, MIN, "trade canary: curve: CurveA…: no route\nstack"), NOW, 15);
    expect(out).toEqual([
      {
        key: "trade-canary",
        text: "Pro trade canary: 2 runs failed in a row: curve: CurveA…: no route",
        side: true,
        trading: true,
      },
    ]);
    // Silent for half an hour at the old 5-minute cadence: the same key, so a stop and a failure
    // are one notice.
    expect(findCanaryProblems(canary(0, 30 * MIN), NOW, 5)).toMatchObject([
      { key: "trade-canary", text: "Pro trade canary: no run for 30 min" },
    ]);
    // At 15 minutes (user ask 2026-10-23) half an hour is one late run, not a stop; three
    // intervals without a run is.
    expect(findCanaryProblems(canary(0, 30 * MIN), NOW, 15)).toEqual([]);
    expect(findCanaryProblems(canary(0, 46 * MIN), NOW, 15)).toMatchObject([
      { key: "trade-canary", text: "Pro trade canary: no run for 46 min" },
    ]);
    expect(canaryQuietMs(5)).toBe(25 * MIN);
    expect(canaryQuietMs(15)).toBe(45 * MIN);
    const text = notificationText(out, [], out);
    expect(text).toMatch(/^<b>⚠️ TrenchScanner Pro trading needs a look<\/b>\n• Pro trade canary: 2 runs/);
    expect(text).not.toContain("scanner jobs");
    expect(notificationText([], ["trade-canary"], [])).toContain("Flowing again:</b> trade-canary");
  });

  it("flags Pro trades failing or expiring above 30% of the last half hour's, given at least 5", () => {
    expect(findTradeOutcomeProblems({ total: 4, failed: 4, expired: 0 })).toEqual([]);
    expect(findTradeOutcomeProblems({ total: 10, failed: 2, expired: 1 })).toEqual([]);
    const out = findTradeOutcomeProblems({ total: 10, failed: 2, expired: 2 });
    expect(out).toEqual([
      {
        key: "trade-outcomes",
        text: "Pro trades: 4 of 10 in the last 30 min failed or expired (2 failed, 2 expired)",
        side: true,
        trading: true,
      },
    ]);
  });

  it("flags Telegram delivery when a linked chat's cursor falls behind", () => {
    expect(findProblems([], [], NOW, new Date(NOW - 2 * MIN))).toEqual([]);
    expect(findProblems([], [], NOW, new Date(NOW - 40 * MIN)).map((p) => p.key)).toEqual(["telegram"]);
  });

  it("words the notice: what stalled, what recovered, what is still out", () => {
    const text = notificationText(
      [{ key: "tokensage", text: "TokenSage reads stored: none in the last 15 min <x>" }],
      ["decisions"],
      [
        { key: "tokensage", text: "..." },
        { key: "job:scan", text: "..." },
      ],
    );
    expect(text).toContain("pipeline stalled");
    expect(text).toContain("&lt;x&gt;");
    expect(text).toContain("Flowing again:</b> decisions");
    expect(text).toContain("Still stalled: job:scan");
  });
});

const HOUR = 60 * MIN;

/** A trainer job's row: ran `agoMs` before NOW, cleanly, on the given cadence. */
const trainer = (
  job: TrainerJobCheck["job"],
  agoMs: number,
  cadence: { intervalMs?: number; dailyAtHourUtc?: number },
  extra: Partial<TrainerJobCheck> = {},
): TrainerJobCheck => ({
  job,
  lastRunAt: new Date(NOW - agoMs),
  lastSuccessAt: new Date(NOW - agoMs),
  lastError: null,
  intervalMs: cadence.intervalMs ?? null,
  dailyAtHourUtc: cadence.dailyAtHourUtc ?? null,
  ...extra,
});

describe("pipeline watch: the trainer's jobs", () => {
  it("watches every trainer job and none of the scanner's", () => {
    expect(TRAINER_JOBS).toEqual(
      expect.arrayContaining([
        "cleanup",
        "outcome-tracking",
        "curator-training",
        "ai-judge",
        "model-backup",
        "label-regrade",
        "wallet-risk",
        "kol-side-wallets",
      ]),
    );
    for (const job of WATCHED_JOBS) expect(TRAINER_JOBS).not.toContain(job);
  });

  it("gives each job room for its own schedule", () => {
    expect(trainerOverdueAfterMs({ intervalMs: null, dailyAtHourUtc: 4 })).toBe(27 * HOUR);
    expect(trainerOverdueAfterMs({ intervalMs: HOUR, dailyAtHourUtc: null })).toBe(4 * HOUR);
    // Training every 6 hours: two intervals and room for a long run.
    expect(trainerOverdueAfterMs({ intervalMs: 6 * HOUR, dailyAtHourUtc: null })).toBe(14 * HOUR);
    // No cadence on the row: the longest guess, never a false alarm.
    expect(trainerOverdueAfterMs({ intervalMs: null, dailyAtHourUtc: null })).toBe(27 * HOUR);
  });

  it("flags a job that stopped running, and leaves one on schedule alone", () => {
    const problems = findTrainerProblems(
      [
        trainer("cleanup", 25 * HOUR, { dailyAtHourUtc: 4 }),
        trainer("outcome-tracking", 30 * HOUR, { dailyAtHourUtc: 5 }),
        trainer("curator-training", 13 * HOUR, { intervalMs: 6 * HOUR }),
        trainer("wallet-risk", 5 * HOUR, { intervalMs: HOUR }),
        trainer("ai-judge", 15 * MIN, { intervalMs: 10 * MIN }),
        // Never ran here: nothing to judge.
        { ...trainer("model-backup", 0, {}), lastRunAt: null, lastSuccessAt: null },
      ],
      NOW,
    );
    expect(problems.map((p) => p.key)).toEqual(["job:outcome-tracking", "job:wallet-risk"]);
    expect(problems.every((p) => p.trainer)).toBe(true);
    expect(problems[0]!.text).toBe("Trainer job outcome-tracking: no run for 30 h");
  });

  it("tells a run lost with its process once, keyed by the run", () => {
    const since = new Date(NOW - 8 * HOUR);
    const lost = trainer("outcome-tracking", 22 * HOUR, { dailyAtHourUtc: 5 }, { lostRunSince: since });
    const problems = findTrainerProblems([lost], NOW);
    expect(problems.map((p) => p.key)).toEqual([`lost:outcome-tracking@${since.toISOString()}`]);
    expect(problems[0]!.text).toContain("was lost with its process");
    expect(findTrainerProblems([{ ...lost, lostRunSince: null }], NOW)).toEqual([]);
  });

  it("watches the nightly full dump's own cron like a daily trainer job", () => {
    expect(TRAINER_JOBS).toContain("db-dump");
    // The row backup.sh writes: daily at 02, so a missed night is told a day and three hours on.
    const night = (agoMs: number, extra: Partial<TrainerJobCheck> = {}) =>
      trainer("db-dump", agoMs, { dailyAtHourUtc: 2 }, extra);
    expect(findTrainerProblems([night(20 * HOUR)], NOW)).toEqual([]);
    expect(findTrainerProblems([night(28 * HOUR)], NOW).map((p) => p.key)).toEqual(["job:db-dump"]);
    const failed = night(10 * MIN, {
      lastSuccessAt: new Date(NOW - 24 * HOUR),
      lastError: "db-dump failed while dumping (exit 1); see the cron's log on Render",
    });
    expect(findTrainerProblems([failed], NOW)[0]!.text).toBe(
      "Trainer job db-dump: last run failed: db-dump failed while dumping (exit 1); see the cron's log on Render",
    );
    // Before the cron has ever run (no bucket yet), there is no row and nothing to tell.
    expect(findTrainerProblems([{ ...night(0), lastRunAt: null, lastSuccessAt: null }], NOW)).toEqual([]);
  });

  it("tells about a frequent job's failures only once they have lasted a while", () => {
    const candle = (sinceSuccessMs: number) =>
      trainer(
        "candle-peaks",
        MIN,
        { intervalMs: MIN },
        {
          lastSuccessAt: new Date(NOW - sinceSuccessMs),
          lastError: "Pump.fun throttled the candle reads (429) before any coin was read",
        },
      );
    expect(findTrainerProblems([candle(3 * MIN)], NOW)).toEqual([]);
    expect(findTrainerProblems([candle(45 * MIN)], NOW).map((p) => p.key)).toEqual(["failed:candle-peaks"]);
    // An hourly job is still told on its first failure.
    const hourly = trainer(
      "wallet-risk",
      MIN,
      { intervalMs: HOUR },
      { lastSuccessAt: new Date(NOW - HOUR), lastError: "boom" },
    );
    expect(findTrainerProblems([hourly], NOW).map((p) => p.key)).toEqual(["failed:wallet-risk"]);
  });

  it("takes a skipped run (the AI judge with no key) as the job being alive", () => {
    expect(findTrainerProblems([trainer("ai-judge", 10 * MIN, { intervalMs: 10 * MIN })], NOW)).toEqual([]);
  });

  it("flags a failed run, but not one a deploy or an admin cut short", () => {
    const failed = trainer(
      "wallet-risk",
      10 * MIN,
      { intervalMs: HOUR },
      { lastSuccessAt: new Date(NOW - 2 * HOUR), lastError: "Timed out fetching a connection\nstack" },
    );
    const cut = trainer(
      "curator-training",
      10 * MIN,
      { intervalMs: 6 * HOUR },
      { lastSuccessAt: new Date(NOW - 6 * HOUR), lastError: SHUTDOWN_INTERRUPTED_ERROR },
    );
    const problems = findTrainerProblems([failed, cut], NOW);
    expect(problems).toEqual([
      {
        key: "failed:wallet-risk",
        text: "Trainer job wallet-risk: last run failed: Timed out fetching a connection",
        trainer: true,
      },
    ]);
  });

  it("tells each night's partial cleanup failure once, under that night's key", () => {
    const night = (day: number) =>
      trainer(
        "cleanup",
        0,
        { dailyAtHourUtc: 4 },
        {
          lastRunAt: new Date(Date.UTC(2026, 9, day, 4, 20)),
          lastSuccessAt: new Date(Date.UTC(2026, 9, day, 4, 20)),
          lastError: "matchOutcomeCopies: canceling statement due to statement timeout",
        },
      );
    const first = findTrainerProblems([night(8)], NOW);
    expect(first.map((p) => p.key)).toEqual(["failed:cleanup@2026-10-08"]);
    expect(first[0]!.text).toContain("last run partly failed: matchOutcomeCopies");
    // The next night fails again: a new key, so a new notice; the old one is not "flowing again".
    const second = findTrainerProblems([night(9)], NOW + 24 * HOUR);
    expect(second.map((p) => p.key)).toEqual(["failed:cleanup@2026-10-09"]);
    expect(
      clearedKeys(new Set(["failed:cleanup@2026-10-08"]), new Set(["failed:cleanup@2026-10-09"])),
    ).toEqual([]);
    // A clean night clears it.
    expect(clearedKeys(new Set(["failed:cleanup@2026-10-09", "job:scan"]), new Set())).toEqual([
      "failed:cleanup@2026-10-09",
      "job:scan",
    ]);
  });

  it("words a trainer notice apart from a pipeline stall", () => {
    const text = notificationText(
      [{ key: "job:cleanup", text: "Trainer job cleanup: no run for 30 h", trainer: true }],
      [],
      [{ key: "job:cleanup", text: "...", trainer: true }],
    );
    expect(text).toContain("trainer needs a look");
    expect(text).not.toContain("pipeline stalled");
    expect(text).toContain("no run for 30 h");
  });
});

describe("pipeline watch: warning before a run-out (audit 2026-10-27, T3)", () => {
  it("flags a chat 5 minutes behind, well before its alerts age out at 15 (WB-12)", () => {
    expect(TELEGRAM_LAG_MS).toBe(5 * MIN);
    expect(findProblems([], [], NOW, new Date(NOW - 4 * MIN))).toEqual([]);
    expect(findProblems([], [], NOW, new Date(NOW - 6 * MIN))).toEqual([
      { key: "telegram", text: "Telegram alerts: a linked chat is 6 min behind" },
    ]);
  });

  it("tells a chat behind for Telegram's hold apart from a stall, so the scanner isn't restarted for it", () => {
    expect(findProblems([], [], NOW, new Date(NOW - 6 * MIN), true)).toEqual([
      {
        key: "telegram",
        text: "Telegram alerts: a linked chat is 6 min behind (Telegram's rate limit on it)",
        side: true,
      },
    ]);
  });

  it("warns as soon as Telegram holds a chat for minutes, before its alerts age out", () => {
    expect(TELEGRAM_HOLD_ALERT_MS).toBe(2 * MIN);
    expect(findTelegramHoldProblems([], NOW)).toEqual([]);
    // A few seconds' wait is Telegram's normal pacing.
    expect(
      findTelegramHoldProblems([{ kind: "supergroup", holdUntil: new Date(NOW + 30_000) }], NOW),
    ).toEqual([]);
    expect(
      findTelegramHoldProblems([{ kind: "supergroup", holdUntil: new Date(NOW + 12.6 * MIN) }], NOW),
    ).toEqual([
      {
        key: "telegram-held",
        text:
          "Telegram alerts: Telegram is holding a linked supergroup for 13 more min (rate limit, until " +
          "13:42 UTC); alerts over 15 min old by then are dropped",
        side: true,
      },
    ]);
    const two = findTelegramHoldProblems(
      [
        { kind: "supergroup", holdUntil: new Date(NOW + 3 * MIN) },
        { kind: "group", holdUntil: new Date(NOW + 5 * MIN) },
      ],
      NOW,
    );
    expect(two[0]!.text).toContain("holding 2 linked chats for 5 more min");
  });

  it("tells alerts dropped unsent once per episode, and clears after a quiet half hour (WB-12)", () => {
    // Without the dispatcher's count: nothing judged, nothing kept.
    expect(findAgedOutProblems(null, null, NOW)).toEqual({ state: null, problems: [] });
    // The first reading is a baseline.
    const base = findAgedOutProblems(null, 40, NOW);
    expect(base.problems).toEqual([]);
    const first = findAgedOutProblems(base.state, 43, NOW + MIN);
    expect(first.problems).toEqual([
      {
        key: "telegram-aged-out",
        text: "Telegram alerts: 3 dropped unsent since 13:31 UTC (over 15 min old when their chat came up)",
        side: true,
      },
    ]);
    // More in the same episode: the same key, the count grows, the start stays.
    const more = findAgedOutProblems(first.state, 50, NOW + 10 * MIN);
    expect(more.problems[0]!.text).toContain("10 dropped unsent since 13:31 UTC");
    // None new, still within the quiet window: the episode holds.
    expect(findAgedOutProblems(more.state, 50, NOW + 30 * MIN).problems).toHaveLength(1);
    // A quiet half hour: it clears.
    const quiet = findAgedOutProblems(more.state, 50, NOW + 10 * MIN + AGED_OUT_QUIET_MS + MIN);
    expect(quiet.problems).toEqual([]);
    expect(quiet.state).toMatchObject({ seen: 50, since: null, count: 0 });
    // A restarted dispatcher counts from zero: its count is all new.
    const restarted = findAgedOutProblems(quiet.state, 2, NOW + 2 * HOUR);
    expect(restarted.problems[0]!.text).toContain("2 dropped unsent");
  });

  it("tells the admins while any linked chat is switched off for failing", () => {
    expect(findDisabledChatProblems(0)).toEqual([]);
    expect(findDisabledChatProblems(1)).toEqual([
      {
        key: "telegram-disabled",
        text: "Telegram alerts: 1 linked chat switched off after a day of failed sends - the owner gets nothing until it is switched back on",
        side: true,
      },
    ]);
    expect(findDisabledChatProblems(3)[0]!.text).toContain("3 linked chats switched off");
  });

  it("times a cycle from its start to the contenders' decisions (DS-11)", () => {
    expect(decidedMs(null)).toBeNull();
    expect(decidedMs({ discovery: 1_000, watchlist: 500 })).toBeNull();
    expect(
      decidedMs({ discovery: 1_000, wallets: 15_000, contenders: 200, curated: 900, candidates: 3_000 }),
    ).toBe(16_200);
  });

  it("flags the cycle's median time to its decisions past 27 s over 10 cycles, clearing under 24 s (DS-11)", () => {
    let state = null as Parameters<typeof findScanLatencyProblems>[0];
    const feed = (ms: number[], start: number, flagged = false) => {
      let problems: ReturnType<typeof findScanLatencyProblems>["problems"] = [];
      ms.forEach((m, i) => {
        ({ state, problems } = findScanLatencyProblems(
          state,
          { runAt: new Date(start + i * MIN), ms: m },
          flagged,
        ));
      });
      return problems;
    };
    // Fewer than 10 cycles: not judged.
    expect(feed(Array(SCAN_LATENCY_SAMPLES - 1).fill(50_000), NOW)).toEqual([]);
    const slow = feed([50_000], NOW + 20 * MIN);
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ key: "scan-latency", side: true });
    expect(slow[0]!.text).toContain("50.0 s from start to contenders decided");
    // The same cycle read again is not a new sample.
    expect(findScanLatencyProblems(state, { runAt: new Date(NOW + 20 * MIN), ms: 1 }, true).state).toEqual(
      state,
    );
    // Down to 25 s: still flagged while it was, not flagged when it wasn't.
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill(25_000), NOW + HOUR, true)).toHaveLength(1);
    expect(findScanLatencyProblems(state, null, false).problems).toEqual([]);
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill(22_000), NOW + 2 * HOUR, true)).toEqual([]);
    // Back to 2026-10-27's 27.6 s median: flagged again.
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill(27_600), NOW + 3 * HOUR)).toHaveLength(1);
  });

  it("flags training runs at three quarters of their deadline, finished or in flight (DB-2)", () => {
    const done = (minutes: number) => ({
      lastSuccessAt: new Date(NOW - HOUR),
      lastRunAt: new Date(NOW - HOUR),
      durationMs: minutes * MIN,
      runningSince: null,
    });
    expect(findTrainingRunProblems(null, done(129), NOW)).toEqual({
      state: { lastCompletedAt: new Date(NOW - HOUR).toISOString(), lastCompletedMs: 129 * MIN },
      problems: [],
    });
    const slow = findTrainingRunProblems(null, done(185), NOW);
    expect(slow.problems).toEqual([
      {
        key: "slow:curator-training",
        text: "Trainer job curator-training: the last completed run took 185 min, 77% of its 240-min deadline - a run past it is cut and redone",
        trainer: true,
      },
    ]);
    // A cut run replaces the heartbeat's meta: the completed run's time is kept here.
    const cut = findTrainingRunProblems(
      slow.state,
      {
        lastSuccessAt: new Date(NOW - 5 * HOUR),
        lastRunAt: new Date(NOW - MIN),
        durationMs: 30 * MIN,
        runningSince: null,
      },
      NOW,
    );
    expect(cut.state).toEqual(slow.state);
    expect(cut.problems).toHaveLength(1);
    // A run in flight past three quarters of the deadline.
    const running = findTrainingRunProblems(
      null,
      { lastSuccessAt: null, lastRunAt: null, durationMs: null, runningSince: new Date(NOW - 190 * MIN) },
      NOW,
    );
    expect(running.problems[0]!.text).toBe(
      "Trainer job curator-training: a run has been going 190 min, 79% of its 240-min deadline",
    );
  });

  it("flags a trainer job whose every run is cut once it has gone that long without completing one (DB-2)", () => {
    const cut = (sinceSuccess: number) =>
      trainer(
        "curator-training",
        10 * MIN,
        { intervalMs: 12 * HOUR },
        {
          lastSuccessAt: new Date(NOW - sinceSuccess),
          lastError: `${SHUTDOWN_INTERRUPTED_ERROR} after 120 min`,
        },
      );
    expect(findTrainerProblems([cut(20 * HOUR)], NOW)).toEqual([]);
    const problems = findTrainerProblems([cut(30 * HOUR)], NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ key: "completed:curator-training", trainer: true });
    expect(problems[0]!.text).toContain(
      "Trainer job curator-training: no run has completed for 30 h - each one was cut",
    );
  });
});

describe("pipeline watch: restarting on a long stall", () => {
  it("warns at 5 minutes, warns again and restarts at 9, then holds off", () => {
    expect(restartStep(null, 0, null, NOW)).toBe("none");
    expect(restartStep(3 * MIN, 0, null, NOW)).toBe("none");
    expect(restartStep(5 * MIN, 0, null, NOW)).toBe("warn5");
    expect(restartStep(6 * MIN, 1, null, NOW)).toBe("none");
    expect(restartStep(9 * MIN, 1, null, NOW)).toBe("warn1");
    // A stall first seen late still gets the last warning before its restart.
    expect(restartStep(9 * MIN, 0, null, NOW)).toBe("warn1");
    // Restart pending: nothing more.
    expect(restartStep(10 * MIN, 2, NOW, NOW)).toBe("none");
  });

  it("restarts at most once an hour, and says so once when it can't", () => {
    // Still stalled after the restart: notify, don't restart again.
    expect(restartStep(15 * MIN, 2, NOW - 5 * MIN, NOW)).toBe("capped");
    expect(restartStep(16 * MIN, -1, NOW - 6 * MIN, NOW)).toBe("none");
    // A new stall 30 minutes after the last restart.
    expect(restartStep(5 * MIN, 0, NOW - 30 * MIN, NOW)).toBe("capped");
    // An hour on, it may restart again.
    expect(restartStep(9 * MIN, 1, NOW - 61 * MIN, NOW)).toBe("warn1");
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("pipeline watch against the database", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: "" } : (undefined as never);
  const TAG = `pw-test-${Date.now()}`;
  /** The alert-path jobs ran just now (other tests leave old heartbeats behind). */
  const jobsRanAt = (at: number) =>
    Promise.all(
      WATCHED_JOBS.map((job) =>
        prisma.systemHeartbeat.upsert({
          where: { job },
          create: { job, lastRunAt: new Date(at), lastSuccessAt: new Date(at) },
          update: { lastRunAt: new Date(at), lastSuccessAt: new Date(at), meta: {} },
        }),
      ),
    );

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    // Trainer rows other test files left behind would read as overdue trainer jobs here.
    await prisma.systemHeartbeat.deleteMany({
      where: { job: { in: [...TRAINER_JOBS, ...SIDE_JOBS, "pipeline-watch", "trade-canary"] } },
    });
    await prisma.announcement.deleteMany({ where: { createdBy: WATCH_ANNOUNCER } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
    await prisma.announcement.deleteMany({ where: { createdBy: WATCH_ANNOUNCER } });
  });

  it("fails the run naming the stalled flow, and stays quiet once it flows again", async () => {
    const now = Date.now();
    // A read stored an hour ago and none since: TokenSage reads have stopped.
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-a`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    await jobsRanAt(now);
    const sendMessage = vi.fn();
    const err = await runPipelineWatch(env, { now, telegram: { sendMessage } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).message).toContain("TokenSage reads stored");
    expect((err as JobFailure).meta).toMatchObject({ stalledKeys: expect.stringContaining("tokensage") });
    // No admin wallets configured: nobody to tell.
    expect(sendMessage).not.toHaveBeenCalled();

    await prisma.tokenNarrative.create({
      data: { mintAddress: `${TAG}-b`, depth: "basic", status: "complete", checkedAt: new Date(now - MIN) },
    });
    const again = await runPipelineWatch(env, { now, telegram: { sendMessage } }).catch((e: unknown) => e);
    const keys =
      again instanceof JobFailure
        ? String(again.meta.stalledKeys)
        : String((again as { stalledKeys?: string }).stalledKeys);
    expect(keys).not.toContain("tokensage");
  });

  it("while Helius's credits are out, names them on a banner instead of warning of a restart", async () => {
    const now = Date.now();
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-c`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: `${TAG}-b` } });
    await jobsRanAt(now);
    const f = meteredFetch(
      (async () =>
        new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}', {
          status: 429,
        })) as typeof fetch,
    );
    await f("https://mainnet.helius-rpc.com/?api-key=k", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "getBalance", params: [] }),
    });
    try {
      // Long enough for the 5-minute warning, had it been a stall.
      await prisma.systemHeartbeat.upsert({
        where: { job: "pipeline-watch" },
        create: {
          job: "pipeline-watch",
          lastRunAt: new Date(now - MIN),
          meta: { stalledKeys: "tokensage", stalledSince: new Date(now - 6 * MIN).toISOString() },
        },
        update: { meta: { stalledKeys: "tokensage", stalledSince: new Date(now - 6 * MIN).toISOString() } },
      });
      const err = await runPipelineWatch(env, { now, restart: vi.fn() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).message).toContain("Helius credits exhausted");
      expect((err as JobFailure).meta.warned).toBe(0);
      const banners = await prisma.announcement.findMany({
        where: { createdBy: WATCH_ANNOUNCER, endedAt: null },
      });
      expect(banners.map((b) => b.message)).toEqual([CREDITS_OUT_BANNER]);
    } finally {
      // At 0: forgotten outright, so the grace after a stand-down doesn't reach the tests below.
      clearHeliusCreditsOut(0);
      await prisma.tokenNarrative.deleteMany({ where: { mintAddress: `${TAG}-c` } });
    }
  });

  it("warns once the database passes the disk line, and not with the check off", async () => {
    const now = Date.now();
    await jobsRanAt(now);
    const over = await runPipelineWatch({ ...env, DB_DISK_ALERT_MB: 1 }, { now }).catch((e: unknown) => e);
    expect(over).toBeInstanceOf(JobFailure);
    expect((over as JobFailure).message).toContain("Database:");
    expect(String((over as JobFailure).meta.stalledKeys)).toContain("disk");
    expect((over as JobFailure).meta.databaseMb).toBeGreaterThanOrEqual(1);
    const off = await runPipelineWatch({ ...env, DB_DISK_ALERT_MB: 0 }, { now }).catch((e: unknown) => e);
    const keys =
      off instanceof JobFailure
        ? String(off.meta.stalledKeys)
        : String((off as { stalledKeys?: string }).stalledKeys);
    expect(keys).not.toContain("disk");
  });

  it("tells only the admins' private chats, never a group an admin linked", async () => {
    const now = Date.now();
    const wallet = `${TAG}-admin`;
    const privateChat = BigInt(Date.now());
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.telegramChat.createMany({
      data: [
        { chatId: privateChat, kind: "private", userId: user.id },
        { chatId: -privateChat, kind: "supergroup", userId: user.id },
      ],
    });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-c`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: `${TAG}-b` } });
    await jobsRanAt(now);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
    await runPipelineWatch(
      { ...env, ADMIN_WALLET_ADDRESSES: wallet },
      { now, telegram: { sendMessage } },
    ).catch(() => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe(privateChat);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("keeps the stall state and the restart cap when a run fails for an ordinary reason", async () => {
    const now = Date.now();
    const wallet = `${TAG}-admin2`;
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.telegramChat.create({
      data: { chatId: BigInt(now) + 7n, kind: "private", userId: user.id },
    });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-f`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    await jobsRanAt(now);
    // A stall already warned about, with a restart 5 minutes ago: this run is "capped" and tells the admins.
    const first = (await runPipelineWatch(env, { now }).catch((e: unknown) => e)) as JobFailure;
    const lastRestartAt = new Date(now - 5 * MIN).toISOString();
    const stalledSince = new Date(now - 20 * MIN).toISOString();
    await prisma.systemHeartbeat.create({
      data: {
        job: "pipeline-watch",
        lastRunAt: new Date(now - MIN),
        meta: { stalledKeys: String(first.meta.stalledKeys), stalledSince, warned: 2, lastRestartAt },
      },
    });
    const sendMessage = vi.fn().mockRejectedValue(new Error("pool timeout"));
    const err = await runPipelineWatch(
      { ...env, ADMIN_WALLET_ADDRESSES: wallet },
      { now, telegram: { sendMessage } },
    ).catch((e: unknown) => e);
    expect(sendMessage).toHaveBeenCalled();
    // A JobFailure, so the scheduler stores this meta instead of wiping the row's.
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).message).toContain("pool timeout");
    expect((err as JobFailure).meta).toMatchObject({
      stalledKeys: first.meta.stalledKeys,
      stalledSince,
      warned: -1,
      lastRestartAt,
    });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("tells the admins about a trainer job once, with no banner and no restart", async () => {
    const now = Date.now();
    const wallet = `${TAG}-admin3`;
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.telegramChat.create({
      data: { chatId: BigInt(now) + 11n, kind: "private", userId: user.id },
    });
    // Every flow quiet-or-flowing: only the trainer job is wrong.
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: { mintAddress: `${TAG}-g`, depth: "basic", status: "complete", checkedAt: new Date(now - MIN) },
    });
    await jobsRanAt(now);
    try {
      await prisma.systemHeartbeat.create({
        data: {
          job: "cleanup",
          lastRunAt: new Date(now - 30 * 3_600_000),
          lastSuccessAt: new Date(now - 30 * 3_600_000),
          meta: { dailyAtHourUtc: 4 },
        },
      });
      const restart = vi.fn();
      const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
      const run = async (at: number) => {
        const out = await runPipelineWatch(
          { ...env, ADMIN_WALLET_ADDRESSES: wallet },
          { now: at, telegram: { sendMessage }, restart },
        ).catch((e: unknown) => e);
        const meta = out instanceof JobFailure ? out.meta : (out as Record<string, unknown>);
        await prisma.systemHeartbeat.upsert({
          where: { job: "pipeline-watch" },
          create: { job: "pipeline-watch", lastRunAt: new Date(at), meta: meta as object },
          update: { lastRunAt: new Date(at), meta: meta as object },
        });
        return meta;
      };
      expect(await run(now)).toMatchObject({ stalledKeys: "job:cleanup", stalledSince: null, warned: 0 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(String(sendMessage.mock.calls[0]![1])).toContain("Trainer job cleanup: no run for 30 h");
      // Minutes on, still overdue: no second message, and never a banner or a restart.
      await jobsRanAt(now + 10 * MIN);
      // The dispatcher kept the chat's cursor current meanwhile.
      await prisma.telegramChat.updateMany({
        where: { userId: user.id },
        data: { sentThrough: new Date(now + 10 * MIN) },
      });
      await run(now + 10 * MIN);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled();
      expect(await prisma.announcement.count({ where: { createdBy: WATCH_ANNOUNCER } })).toBe(0);
    } finally {
      await prisma.systemHeartbeat.deleteMany({ where: { job: "cleanup" } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("warns visitors, restarts once, and takes the banner down when it flows again", async () => {
    const t0 = Date.now();
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-d`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(t0 - 60 * MIN),
      },
    });
    const restart = vi.fn();
    // The scheduler stores a failed run's meta on the heartbeat; do the same between runs.
    const run = async (now: number) => {
      await jobsRanAt(now);
      const out = await runPipelineWatch(env, { now, restart }).catch((e: unknown) => e);
      const meta = out instanceof JobFailure ? out.meta : (out as Record<string, unknown>);
      await prisma.systemHeartbeat.upsert({
        where: { job: "pipeline-watch" },
        create: { job: "pipeline-watch", lastRunAt: new Date(now), meta: meta as object },
        update: { lastRunAt: new Date(now), meta: meta as object },
      });
      return meta;
    };
    const banners = () =>
      prisma.announcement.findMany({ where: { createdBy: WATCH_ANNOUNCER, endedAt: null } });

    await run(t0);
    expect(await banners()).toHaveLength(0);
    await run(t0 + 5 * MIN);
    expect((await banners()).map((b) => b.message)).toEqual([expect.stringContaining("about 5 minutes")]);
    expect(restart).not.toHaveBeenCalled();
    await run(t0 + 9 * MIN);
    expect(restart).toHaveBeenCalledTimes(1);
    expect((await banners()).some((b) => b.message.includes("about a minute"))).toBe(true);
    // Still stalled after the restart: no second one within the hour.
    expect(await run(t0 + 14 * MIN)).toMatchObject({ warned: -1 });
    expect(restart).toHaveBeenCalledTimes(1);

    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-e`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(t0 + 15 * MIN),
      },
    });
    expect(await run(t0 + 16 * MIN)).toMatchObject({ stalled: 0, warned: 0 });
    expect(await banners()).toHaveLength(0);
  });

  it("tells the admins when the trade canary keeps failing and when Pro trades go wrong, then when it clears", async () => {
    const now = Date.now();
    const wallet = `${TAG}-admin4`;
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.telegramChat.create({
      data: { chatId: BigInt(now) + 13n, kind: "private", userId: user.id },
    });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: { mintAddress: `${TAG}-h`, depth: "basic", status: "complete", checkedAt: new Date(now - MIN) },
    });
    await jobsRanAt(now);
    const canaryAt = async (at: number, consecutiveFailures: number) =>
      prisma.systemHeartbeat.upsert({
        where: { job: "trade-canary" },
        create: {
          job: "trade-canary",
          lastRunAt: new Date(at),
          lastError: "trade canary: sender: 503",
          meta: { consecutiveFailures },
        },
        update: { lastRunAt: new Date(at), meta: { consecutiveFailures } },
      });
    // Five Pro trades in the last half hour, three of them failed or expired.
    const statuses = ["failed", "expired", "failed", "confirmed", "sent"];
    await prisma.platformTrade.createMany({
      data: statuses.map((status, i) => ({
        signature: `${TAG}-sig${i}`,
        wallet,
        mint: `${TAG}-mint`,
        side: "buy",
        lamports: 10_000_000n,
        networkFeeLamports: 10_000n,
        status,
        sentAt: new Date(now - 5 * MIN),
      })),
    });
    try {
      const restart = vi.fn();
      const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
      const run = async (at: number) => {
        const out = await runPipelineWatch(
          { ...env, ADMIN_WALLET_ADDRESSES: wallet },
          { now: at, telegram: { sendMessage }, restart },
        ).catch((e: unknown) => e);
        const meta = out instanceof JobFailure ? out.meta : (out as Record<string, unknown>);
        await prisma.systemHeartbeat.upsert({
          where: { job: "pipeline-watch" },
          create: { job: "pipeline-watch", lastRunAt: new Date(at), meta: meta as object },
          update: { lastRunAt: new Date(at), meta: meta as object },
        });
        return meta;
      };
      // One failed canary run: not yet. The trades already are.
      await canaryAt(now, 1);
      expect(await run(now)).toMatchObject({
        stalledKeys: "trade-outcomes",
        stalledSince: null,
        tradeOutcomes: { total: 5, failed: 2, expired: 1 },
      });
      expect(String(sendMessage.mock.calls[0]![1])).toContain("Pro trades: 3 of 5 in the last 30 min");
      // The second in a row: one message, under its own heading, no banner and no restart.
      await canaryAt(now, 2);
      expect(await run(now)).toMatchObject({
        stalledKeys: "trade-canary,trade-outcomes",
        stalledSince: null,
      });
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(String(sendMessage.mock.calls[1]![1])).toContain("Pro trading needs a look");
      expect(String(sendMessage.mock.calls[1]![1])).toContain(
        "Pro trade canary: 2 runs failed in a row: sender: 503",
      );
      await canaryAt(now, 3);
      await run(now);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      // It passes again, and the trades settle: one "flowing again".
      await canaryAt(now, 0);
      await prisma.platformTrade.updateMany({ where: { wallet }, data: { status: "confirmed" } });
      expect(await run(now)).toMatchObject({ stalled: 0 });
      expect(sendMessage).toHaveBeenCalledTimes(3);
      expect(String(sendMessage.mock.calls[2]![1])).toContain(
        "Flowing again:</b> trade-canary, trade-outcomes",
      );
      expect(restart).not.toHaveBeenCalled();
      expect(await prisma.announcement.count({ where: { createdBy: WATCH_ANNOUNCER } })).toBe(0);
    } finally {
      await prisma.platformTrade.deleteMany({ where: { wallet } });
      await prisma.systemHeartbeat.deleteMany({ where: { job: "trade-canary" } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe.skipIf(!dbAvailable)("pipeline watch: the run-out warnings carry over between runs", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: "" } : (undefined as never);
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.systemHeartbeat.deleteMany({
      where: { job: { in: ["pipeline-watch", "scan", "telegram-dispatch"] } },
    });
  });

  it("keeps the cycle samples and the dispatcher's count on its heartbeat, and reads them back", async () => {
    await prisma.systemHeartbeat.deleteMany({
      where: { job: { in: [...TRAINER_JOBS, ...SIDE_JOBS, "pipeline-watch", "trade-canary"] } },
    });
    const now = Date.now();
    const run = async (at: number, agedOutSinceBoot: number) => {
      for (const job of WATCHED_JOBS) {
        const meta =
          job === "scan"
            ? { stagesMs: { discovery: 2_000, wallets: 15_000, contenders: 300, candidates: 4_000 } }
            : job === "telegram-dispatch"
              ? { agedOutSinceBoot }
              : {};
        await prisma.systemHeartbeat.upsert({
          where: { job },
          create: { job, lastRunAt: new Date(at), lastSuccessAt: new Date(at), meta },
          update: { lastRunAt: new Date(at), lastSuccessAt: new Date(at), meta },
        });
      }
      const out = await runPipelineWatch(env, { now: at, telegram: { sendMessage: vi.fn() } }).catch(
        (e: unknown) => (e instanceof JobFailure ? e.meta : Promise.reject(e)),
      );
      // The scheduler stores a run's meta on the job's heartbeat; the next run reads it back.
      await prisma.systemHeartbeat.upsert({
        where: { job: "pipeline-watch" },
        create: { job: "pipeline-watch", lastRunAt: new Date(at), meta: out as object },
        update: { lastRunAt: new Date(at), meta: out as object },
      });
      return out as Record<string, unknown>;
    };
    const first = await run(now - MIN, 7);
    expect(first.scanLatency).toEqual({ samples: "17300", lastRunAt: new Date(now - MIN).toISOString() });
    expect(first.telegramAgedOut).toMatchObject({ seen: 7, since: null, count: 0 });
    const second = await run(now, 9);
    expect(second.scanLatency).toEqual({ samples: "17300,17300", lastRunAt: new Date(now).toISOString() });
    expect(second.telegramAgedOut).toMatchObject({ seen: 9, count: 2 });
    expect(String(second.stalledKeys)).toContain("telegram-aged-out");
  });
});
