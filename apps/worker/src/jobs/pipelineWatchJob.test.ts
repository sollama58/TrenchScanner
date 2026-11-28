// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
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
  findHeliusErrorProblems,
  findLowFlowProblems,
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
  FDSA_DECIDE_FAIL_MIN,
  findFdsaProblems,
  FDSA_QUIET_MS,
  FDSA_QUIET_MIN_ALERTS,
  DatabaseDownWatch,
  DB_DOWN_RUNS,
  isDatabaseUnreachable,
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
    const problems = findProblems([flow("discovery", 0, 4_000), flow("decisions", 12, 900)], [], NOW);
    expect(problems).toEqual([expect.objectContaining({ key: "discovery" })]);
    // A stall of the alert path: it starts the clock to the banner and the restart.
    expect(problems[0]!.side).toBeUndefined();
  });

  it("puts a quiet TokenSage flow full of failed answers down to TokenSage: notify, no restart", () => {
    const [p] = findProblems([{ ...flow("tokensage", 0, 4_000), failed: 37 }], [], NOW);
    expect(p).toMatchObject({ key: "tokensage", side: true });
    expect(p!.text).toContain("TokenSage answered 37 as failed");
  });

  // Program audit 2026-11-28, FD-4: with TokenSage down (no answers at all, so no failed ones)
  // the quiet flow counted as a scanner stall, and the scanner restarted itself at ten minutes
  // for an outage that was not its own.
  it("puts a TokenSage flow at zero down to TokenSage even with no failed answers", () => {
    for (const f of [flow("tokensage", 0, 4_000), { ...flow("tokensage", 0, 4_000), failed: 0 }]) {
      const [p] = findProblems([f], [], NOW);
      expect(p).toMatchObject({ key: "tokensage", side: true });
      expect(p!.text).toContain("TokenSage is not answering");
    }
  });

  it("notices a flow running at a fraction of its usual output", () => {
    // 4,000 a day is about 42 a quarter hour; 60 in the same quarter hour yesterday.
    const low = { ...flow("tokensage", 5, 4_000), dayAgo: 60 };
    expect(findLowFlowProblems([low])).toEqual([
      expect.objectContaining({
        key: "tokensage:low",
        side: true,
        text: expect.stringContaining("5 in the last 15 min"),
      }),
    ]);
    // Under a fifth of yesterday's window but not of the day's average (a busy window a day ago), and
    // the other way round (a quiet hour of the day): one odd reference alone raises nothing.
    expect(findLowFlowProblems([{ ...flow("tokensage", 10, 4_000), dayAgo: 200 }])).toEqual([]);
    expect(findLowFlowProblems([{ ...flow("tokensage", 7, 9_600), dayAgo: 30 }])).toEqual([]);
    // A quiet stage's fifth is a handful: not judged.
    expect(findLowFlowProblems([{ ...flow("modelAlerts", 1, 300), dayAgo: 20 }])).toEqual([]);
    // Zero is the stall rule's, and a flow whose day-ago window was not read is not judged.
    expect(findLowFlowProblems([{ ...flow("tokensage", 0, 4_000), dayAgo: 60 }])).toEqual([]);
    expect(findLowFlowProblems([flow("tokensage", 5, 4_000)])).toEqual([]);
    // Healthy.
    expect(findLowFlowProblems([{ ...flow("decisions", 40, 4_000), dayAgo: 60 }])).toEqual([]);
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

  it("flags Helius failing 5% of its requests two half hours running (audit 2026-11-28, FD-7)", () => {
    // The usual day: 40 failed in 200,267.
    expect(
      findHeliusErrorProblems([
        { requests: 4_000, errors: 1 },
        { requests: 4_200, errors: 0 },
      ]),
    ).toEqual([]);
    // One bad half hour says nothing, whichever it is.
    expect(
      findHeliusErrorProblems([
        { requests: 4_000, errors: 2 },
        { requests: 4_000, errors: 400 },
      ]),
    ).toEqual([]);
    expect(
      findHeliusErrorProblems([
        { requests: 4_000, errors: 400 },
        { requests: 4_000, errors: 2 },
      ]),
    ).toEqual([]);
    // Too few requests to call a rate (a scanner that is mostly down is another notice's).
    expect(
      findHeliusErrorProblems([
        { requests: 4_000, errors: 400 },
        { requests: 40, errors: 30 },
      ]),
    ).toEqual([]);
    expect(
      findHeliusErrorProblems([
        { requests: 0, errors: 0 },
        { requests: 0, errors: 0 },
      ]),
    ).toEqual([]);
    const out = findHeliusErrorProblems([
      { requests: 4_000, errors: 240 },
      { requests: 5_000, errors: 400 },
    ]);
    expect(out.map((p) => p.key)).toEqual(["helius-errors"]);
    // Notified, with no banner and no restart: a restart does not mend Helius.
    expect(out[0]!.side).toBe(true);
    expect(out[0]!.text).toContain("Helius failed 8% of requests in the last 30 minutes (400 of 5,000)");
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
          new Set(flagged ? ["scan-latency"] : []),
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
    expect(
      findScanLatencyProblems(state, { runAt: new Date(NOW + 20 * MIN), ms: 1 }, new Set(["scan-latency"]))
        .state,
    ).toEqual(state);
    // Down to 25 s: still flagged while it was, not flagged when it wasn't.
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill(25_000), NOW + HOUR, true)).toHaveLength(1);
    expect(findScanLatencyProblems(state, null, new Set()).problems).toEqual([]);
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill(22_000), NOW + 2 * HOUR, true)).toEqual([]);
    // Back to 2026-10-27's 27.6 s median: flagged again.
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill(27_600), NOW + 3 * HOUR)).toHaveLength(1);
  });

  it("flags the fast path's and early decisions' median times on their own windows (check-in 2026-10-29)", () => {
    let state = null as Parameters<typeof findScanLatencyProblems>[0];
    const feed = (
      times: { fastMs?: number | null; earlyMs?: number | null }[],
      start: number,
      flagged: string[] = [],
    ) => {
      let problems: ReturnType<typeof findScanLatencyProblems>["problems"] = [];
      times.forEach((t, i) => {
        ({ state, problems } = findScanLatencyProblems(
          state,
          { runAt: new Date(start + i * MIN), ms: 20_000, ...t },
          new Set(flagged),
        ));
      });
      return problems;
    };
    // 2026-10-29's fast path (5.4-6.6 s) and a cycle with no fast-path decision: no sample, no problem.
    expect(feed(Array(SCAN_LATENCY_SAMPLES).fill({ fastMs: 6_000, earlyMs: 12_000 }), NOW)).toEqual([]);
    expect(feed([{ fastMs: null, earlyMs: null }], NOW + HOUR)).toEqual([]);
    expect(state!.fastSamples).toHaveLength(SCAN_LATENCY_SAMPLES);
    expect(state!.samples).toHaveLength(SCAN_LATENCY_SAMPLES);
    // Twice that: flagged, apart from the cycle's own alarm.
    const slow = feed(Array(SCAN_LATENCY_SAMPLES).fill({ fastMs: 13_000 }), NOW + 2 * HOUR);
    expect(slow.map((p) => p.key)).toEqual(["fast-path-latency"]);
    expect(slow[0]).toMatchObject({ side: true });
    expect(slow[0]!.text).toContain("13.0 s from a coin crossing to its decision");
    // Down to 10 s: still up while it was, not raised when it wasn't; under 9 s clears.
    expect(
      feed(Array(SCAN_LATENCY_SAMPLES).fill({ fastMs: 10_000 }), NOW + 3 * HOUR, ["fast-path-latency"]),
    ).toHaveLength(1);
    expect(feed([{ fastMs: 10_000 }], NOW + 4 * HOUR)).toEqual([]);
    expect(
      feed(Array(SCAN_LATENCY_SAMPLES).fill({ fastMs: 8_000 }), NOW + 5 * HOUR, ["fast-path-latency"]),
    ).toEqual([]);
    // The early decisions past 20 s, clearing under 17 s.
    const late = feed(Array(SCAN_LATENCY_SAMPLES).fill({ earlyMs: 21_000 }), NOW + 6 * HOUR);
    expect(late.map((p) => p.key)).toEqual(["early-decision-latency"]);
    expect(late[0]!.text).toContain("21.0 s from the cycle's start to a coin decided early");
    expect(feed([{ earlyMs: 18_000 }], NOW + 7 * HOUR, ["early-decision-latency"])).toHaveLength(1);
    expect(
      feed(Array(SCAN_LATENCY_SAMPLES).fill({ earlyMs: 16_000 }), NOW + 8 * HOUR, ["early-decision-latency"]),
    ).toEqual([]);
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

describe("pipeline watch: the AI desk (audit 2026-11-02, DB-4)", () => {
  const check = (over: Partial<Parameters<typeof findFdsaProblems>[0] & object> = {}) => ({
    deskRunning: true,
    scannerEnabled: true,
    lastReviewAt: new Date(NOW - MIN),
    alertsInWindow: 40,
    decidesInWindow: 0,
    decidesFailedInWindow: 0,
    lastDecideError: null,
    ...over,
  });

  it("tells the admins when the desk is set to run but the scanner has FDSA off", () => {
    const problems = findFdsaProblems(check({ scannerEnabled: false }), NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ key: "fdsa-off", side: true });
    expect(problems[0]!.text).toContain("FDSA_ENABLED");
    // Off at the scanner is not judged on the review flow too: one notice, not two.
    expect(findFdsaProblems(check({ scannerEnabled: false, lastReviewAt: null }), NOW)).toHaveLength(1);
  });

  it("flags a desk that stored no review for half an hour while alerts kept arriving, and no restart", () => {
    const quiet = check({ lastReviewAt: new Date(NOW - FDSA_QUIET_MS) });
    const problems = findFdsaProblems(quiet, NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ key: "fdsa-quiet", side: true });
    expect(problems[0]!.text).toContain("40 curated alerts");
    // Never a review at all counts as quiet too.
    expect(findFdsaProblems(check({ lastReviewAt: null }), NOW)).toHaveLength(1);
    // The scanner's view unknown (an old heartbeat): judged on the flow alone.
    expect(findFdsaProblems(check({ scannerEnabled: null, lastReviewAt: null }), NOW)).toHaveLength(1);
  });

  it("stays quiet when the market is: few alerts, a recent review, a paused desk, or no desk", () => {
    expect(
      findFdsaProblems(check({ lastReviewAt: null, alertsInWindow: FDSA_QUIET_MIN_ALERTS - 1 }), NOW),
    ).toEqual([]);
    expect(findFdsaProblems(check({ lastReviewAt: new Date(NOW - FDSA_QUIET_MS + MIN) }), NOW)).toEqual([]);
    expect(
      findFdsaProblems(check({ deskRunning: false, scannerEnabled: false, lastReviewAt: null }), NOW),
    ).toEqual([]);
    expect(findFdsaProblems(null, NOW)).toEqual([]);
  });

  it("flags a run of failed decides even while the screen keeps storing reviews (audit 2026-11-07)", () => {
    const stalled = check({
      decidesInWindow: FDSA_DECIDE_FAIL_MIN,
      decidesFailedInWindow: FDSA_DECIDE_FAIL_MIN,
      lastDecideError:
        'API error 400: 400 {"type":"error","error":{"type":"invalid_request_error",\n"message":"usage limit"}}',
    });
    const problems = findFdsaProblems(stalled, NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ key: "fdsa-decide-failing", side: true });
    expect(problems[0]!.text).toContain(`${FDSA_DECIDE_FAIL_MIN} of ${FDSA_DECIDE_FAIL_MIN}`);
    // The provider's text is shown on one line and cut short, never in full.
    expect(problems[0]!.text).toContain("API error 400");
    expect(problems[0]!.text).not.toContain("\n");
    expect(problems[0]!.text.length).toBeLessThan(400);
    // Under the minimum, nothing: a single failure is the API's bad minute.
    expect(
      findFdsaProblems(
        check({ decidesInWindow: FDSA_DECIDE_FAIL_MIN - 1, decidesFailedInWindow: FDSA_DECIDE_FAIL_MIN - 1 }),
        NOW,
      ),
    ).toEqual([]);
    // Fewer than half failed, nothing: the desk is mostly deciding.
    expect(
      findFdsaProblems(check({ decidesInWindow: 12, decidesFailedInWindow: 5, lastDecideError: "x" }), NOW),
    ).toEqual([]);
    // Off at the scanner still wins: one notice, not two.
    expect(
      findFdsaProblems(
        check({
          scannerEnabled: false,
          decidesInWindow: 12,
          decidesFailedInWindow: 12,
          lastDecideError: "x",
        }),
        NOW,
      ),
    ).toMatchObject([{ key: "fdsa-off" }]);
  });

  it("flags a partial outage and failed revisions, which the every-one-failed rule never did (audit 2026-11-28, AI-6)", () => {
    // 11 of 12 failed is a rate limit letting one call through: under the first rule it said nothing.
    const partial = findFdsaProblems(
      check({ decidesInWindow: 12, decidesFailedInWindow: 11, lastDecideError: "429 rate limit" }),
      NOW,
    );
    expect(partial).toMatchObject([{ key: "fdsa-decide-failing", side: true }]);
    expect(partial[0]!.text).toContain("11 of 12");
    // Three failed of three: the first rule waited for five, about four hours at 30 decides a day.
    expect(findFdsaProblems(check({ decidesInWindow: 3, decidesFailedInWindow: 3 }), NOW)).toMatchObject([
      { key: "fdsa-decide-failing" },
    ]);
    // Exactly half counts; one under does not.
    expect(findFdsaProblems(check({ decidesInWindow: 6, decidesFailedInWindow: 3 }), NOW)).toHaveLength(1);
    expect(findFdsaProblems(check({ decidesInWindow: 7, decidesFailedInWindow: 3 }), NOW)).toEqual([]);
    // Revisions are read the same way, under their own key.
    const revise = findFdsaProblems(
      check({ revisesInWindow: 4, revisesFailedInWindow: 3, lastReviseError: "overloaded" }),
      NOW,
    );
    expect(revise).toMatchObject([{ key: "fdsa-revise-failing", side: true }]);
    expect(revise[0]!.text).toContain("3 of 4 plan revisions");
    expect(findFdsaProblems(check({ revisesInWindow: 4, revisesFailedInWindow: 1 }), NOW)).toEqual([]);
    // Both at once: two notices.
    expect(
      findFdsaProblems(
        check({ decidesInWindow: 4, decidesFailedInWindow: 4, revisesInWindow: 3, revisesFailedInWindow: 3 }),
        NOW,
      ).map((p) => p.key),
    ).toEqual(["fdsa-decide-failing", "fdsa-revise-failing"]);
  });

  it("words the notice under the scanner-jobs heading, not as a stall", () => {
    const text = notificationText(findFdsaProblems(check({ scannerEnabled: false }), NOW), [], []);
    expect(text).toContain("scanner jobs need a look");
    expect(text).not.toContain("pipeline stalled");
  });
});

describe("pipeline watch: the database unreachable (audit 2026-11-28, FD-3)", () => {
  const unreachable = () =>
    new Prisma.PrismaClientKnownRequestError("Can't reach database server at `db:5432`", {
      code: "P1001",
      clientVersion: "test",
    });
  const env = { ADMIN_WALLET_ADDRESSES: "", TELEGRAM_BOT_TOKEN: "" } as unknown as Env;

  it("tells a connection failure from every other error", () => {
    expect(isDatabaseUnreachable(unreachable())).toBe(true);
    expect(isDatabaseUnreachable(new Prisma.PrismaClientInitializationError("no", "test"))).toBe(true);
    expect(
      isDatabaseUnreachable(new Error("Timed out fetching a new connection from the connection pool.")),
    ).toBe(true);
    expect(isDatabaseUnreachable(new Error("FATAL: the database system is shutting down"))).toBe(true);
    // A unique-key clash is a query's answer, and a refused Helius call is not the database.
    expect(
      isDatabaseUnreachable(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }),
      ),
    ).toBe(false);
    expect(isDatabaseUnreachable(new Error("fetch failed: connect ECONNREFUSED 10.0.0.1:443"))).toBe(false);
  });

  it("tells the admins kept from the last good run, once, on the third failed run, and again when it is back", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const database = new DatabaseDownWatch();
    const deps = { telegram: { sendMessage }, database, adminChats: async () => [7n, 8n] };
    const good = () => runPipelineWatch(env, { ...deps, now: 1_000_000, watch: async () => ({}) });
    const down = () =>
      runPipelineWatch(env, {
        ...deps,
        // With the database down the chats cannot be read either: only the kept ones are used.
        adminChats: async () => {
          throw unreachable();
        },
        watch: async () => {
          throw unreachable();
        },
      }).catch((e: unknown) => e);

    await good();
    for (let i = 1; i < DB_DOWN_RUNS; i++) expect(await down()).toBeInstanceOf(Error);
    expect(sendMessage).not.toHaveBeenCalled(); // a blip of a run or two is the retry's
    await down();
    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([7n, 8n]);
    expect(String(sendMessage.mock.calls[0]![1])).toContain("cannot reach its database");
    await down();
    await down();
    expect(sendMessage).toHaveBeenCalledTimes(2); // said once while it lasts
    await good();
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(String(sendMessage.mock.calls[3]![1])).toContain("reaches the database again");
    await good();
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it("says nothing for an error that is not the connection, or for a stall the watch found", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const database = new DatabaseDownWatch();
    const deps = { telegram: { sendMessage }, database, adminChats: async () => [7n] };
    await runPipelineWatch(env, { ...deps, watch: async () => ({}) });
    for (let i = 0; i < DB_DOWN_RUNS + 1; i++) {
      await runPipelineWatch(env, {
        ...deps,
        watch: async () => {
          throw new Error("unexpected token in JSON");
        },
      }).catch(() => undefined);
    }
    // Two connection failures, then the watch's own stall verdict: the run's reads answered.
    for (let i = 0; i < DB_DOWN_RUNS - 1; i++) {
      await runPipelineWatch(env, {
        ...deps,
        watch: async () => {
          throw unreachable();
        },
      }).catch(() => undefined);
    }
    await runPipelineWatch(env, {
      ...deps,
      watch: async () => {
        throw new JobFailure("1 stalled", {});
      },
    }).catch(() => undefined);
    await runPipelineWatch(env, {
      ...deps,
      watch: async () => {
        throw unreachable();
      },
    }).catch(() => undefined);
    expect(sendMessage).not.toHaveBeenCalled();
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

  /**
   * A stall of the alert path itself: the scan has not run for an hour. A quiet TokenSage flow was
   * the stall these tests used until it stopped being one (program audit 2026-11-28, FD-4).
   */
  const scanQuietAt = (at: number) =>
    prisma.systemHeartbeat.update({
      where: { job: "scan" },
      data: { lastRunAt: new Date(at - 60 * MIN), lastSuccessAt: new Date(at - 60 * MIN) },
    });

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

    // A failed answer is not a read stored (2026-11-09: TokenSage failed every read for 2.5 days
    // and this flow, counting them, read as flowing).
    await prisma.tokenNarrative.create({
      data: { mintAddress: `${TAG}-f`, depth: "basic", status: "failed", checkedAt: new Date(now - MIN) },
    });
    const failing = await runPipelineWatch(env, { now, telegram: { sendMessage } }).catch((e: unknown) => e);
    expect(failing).toBeInstanceOf(JobFailure);
    expect((failing as JobFailure).message).toContain("TokenSage answered 1 as failed");
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: `${TAG}-f` } });

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

  it("reads Helius's failed share from the usage rows, and stays quiet with one bad half hour", async () => {
    const now = Date.now();
    await jobsRanAt(now);
    const usage = (at: number, requests: number, errors: number) =>
      prisma.apiUsage.create({
        data: {
          bucket: new Date(Math.floor(at / (5 * MIN)) * 5 * MIN),
          process: TAG,
          provider: "helius",
          endpoint: "POST /",
          feature: "scan",
          calls: requests,
          requests,
          errors,
        },
      });
    try {
      // Far more than any other test's rows in the same hour, so the shares are these rows'.
      await usage(now - 50 * MIN, 1_000_000, 200_000);
      await usage(now - 40 * MIN, 1_000_000, 0);
      await usage(now - 20 * MIN, 1_000_000, 200_000);
      const err = await runPipelineWatch(env, { now, telegram: { sendMessage: vi.fn() } }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).meta).toMatchObject({
        stalledKeys: expect.stringContaining("helius-errors"),
      });
      expect((err as JobFailure).message).toMatch(/Helius failed 20% of requests in the last 30 minutes/);
      // Not a stall of the alert path: no restart clock.
      expect((err as JobFailure).meta).toMatchObject({ stalledSince: null });

      // The older half hour clean: one bad half hour is not yet a notice.
      await prisma.apiUsage.updateMany({
        where: { process: TAG, bucket: { lt: new Date(now - 35 * MIN) } },
        data: { errors: 0 },
      });
      const again = await runPipelineWatch(env, { now, telegram: { sendMessage: vi.fn() } }).catch(
        (e: unknown) => e,
      );
      const keys =
        again instanceof JobFailure
          ? String(again.meta.stalledKeys)
          : String((again as { stalledKeys?: string }).stalledKeys);
      expect(keys).not.toContain("helius-errors");
    } finally {
      await prisma.apiUsage.deleteMany({ where: { process: TAG } });
    }
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

  it("says a notice again on the next run when Telegram refused it", async () => {
    const now = Date.now();
    const wallet = `${TAG}-admin3`;
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.telegramChat.create({
      data: { chatId: BigInt(now) + 11n, kind: "private", userId: user.id },
    });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-c`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    await jobsRanAt(now);
    const adminEnv = { ...env, ADMIN_WALLET_ADDRESSES: wallet };
    // The scheduler stores a run's meta on the heartbeat row; the next run reads its state there.
    const store = (run: unknown) => {
      const meta = (run as JobFailure).meta as Prisma.InputJsonObject;
      return prisma.systemHeartbeat.upsert({
        where: { job: "pipeline-watch" },
        create: { job: "pipeline-watch", lastRunAt: new Date(now), meta },
        update: { meta },
      });
    };
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
    const refusing = vi.fn().mockResolvedValue({ ok: false, code: 429 });
    const first = await runPipelineWatch(adminEnv, { now, telegram: { sendMessage: refusing } }).catch(
      (e: unknown) => e,
    );
    expect(refusing).toHaveBeenCalledTimes(1);
    expect((first as JobFailure).meta).toMatchObject({ notified: 0, noticesUndelivered: true });
    // Not stored as told: the keys are the ones the run started with.
    expect(String((first as JobFailure).meta.stalledKeys)).not.toContain("tokensage");
    await store(first);

    const accepting = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const second = await runPipelineWatch(adminEnv, { now, telegram: { sendMessage: accepting } }).catch(
      (e: unknown) => e,
    );
    expect(accepting).toHaveBeenCalledTimes(1);
    expect(String(accepting.mock.calls[0]![1])).toContain("TokenSage");
    expect((second as JobFailure).meta).toMatchObject({ notified: 1, noticesUndelivered: false });
    expect(String((second as JobFailure).meta.stalledKeys)).toContain("tokensage");
    await store(second);

    // Told once: a third run has nothing new to say.
    const third = vi.fn().mockResolvedValue({ ok: true, result: {} });
    await runPipelineWatch(adminEnv, { now, telegram: { sendMessage: third } }).catch(() => undefined);
    expect(third.mock.calls.map((c) => String(c[1]))).toEqual([]);
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
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
    await scanQuietAt(now);
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

  // Program audit 2026-11-28, FD-4: TokenSage down used to count as a scanner stall, with the
  // visitors' banner at five minutes and a restart at ten that mended nothing.
  it("tells of TokenSage going quiet without a banner or a restart", async () => {
    const t0 = Date.now();
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-q`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(t0 - 60 * MIN),
      },
    });
    const restart = vi.fn();
    for (const now of [t0, t0 + 5 * MIN, t0 + 11 * MIN]) {
      await jobsRanAt(now);
      const out = await runPipelineWatch(env, { now, restart }).catch((e: unknown) => e);
      expect(out).toBeInstanceOf(JobFailure);
      expect((out as JobFailure).message).toContain("TokenSage is not answering");
      expect((out as JobFailure).meta).toMatchObject({ warned: 0 });
      await prisma.systemHeartbeat.upsert({
        where: { job: "pipeline-watch" },
        create: { job: "pipeline-watch", lastRunAt: new Date(now), meta: (out as JobFailure).meta as object },
        update: { lastRunAt: new Date(now), meta: (out as JobFailure).meta as object },
      });
    }
    expect(restart).not.toHaveBeenCalled();
    expect(await prisma.announcement.count({ where: { createdBy: WATCH_ANNOUNCER, endedAt: null } })).toBe(0);
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
    const run = async (now: number, scanQuiet = true) => {
      await jobsRanAt(now);
      if (scanQuiet) await scanQuietAt(now);
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
    expect(await run(t0 + 16 * MIN, false)).toMatchObject({ stalled: 0, warned: 0 });
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
            ? {
                stagesMs: { discovery: 2_000, wallets: 15_000, contenders: 300, candidates: 4_000 },
                entryFastPath: { fastScans: 2, crossToDecisionMsMedian: 6_053 },
                earlyDecisions: { coins: 3, waves: 1, firstAtMs: 11_000, msMedian: 11_000 },
              }
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
    expect(first.scanLatency).toEqual({
      samples: "17300",
      fastSamples: "6053",
      earlySamples: "11000",
      lastRunAt: new Date(now - MIN).toISOString(),
    });
    expect(first.telegramAgedOut).toMatchObject({ seen: 7, since: null, count: 0 });
    const second = await run(now, 9);
    expect(second.scanLatency).toEqual({
      samples: "17300,17300",
      fastSamples: "6053,6053",
      earlySamples: "11000,11000",
      lastRunAt: new Date(now).toISOString(),
    });
    expect(second.telegramAgedOut).toMatchObject({ seen: 9, count: 2 });
    expect(String(second.stalledKeys)).toContain("telegram-aged-out");
  });
});
