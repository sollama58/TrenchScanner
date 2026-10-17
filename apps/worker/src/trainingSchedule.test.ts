import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_RUN_RETRY_MS,
  keepCadenceDelayMs,
  offsetCadenceDelayMs,
  trainingFirstRunDelayMs,
} from "./trainingSchedule.js";
import { DEADLINE_ERROR, SHUTDOWN_INTERRUPTED_ERROR, STOPPED_ERROR } from "./scheduler.js";

const H = 3_600_000;
const NOW = Date.parse("2026-10-12T17:20:00Z");

describe("trainingFirstRunDelayMs", () => {
  it("runs at once when training has never run", () => {
    expect(trainingFirstRunDelayMs(null, 24 * H, NOW)).toBe(0);
  });

  it("keeps the cadence after a finished run", () => {
    const hb = { lastRunAt: new Date(NOW - 2 * H), lastError: null, meta: {} };
    expect(trainingFirstRunDelayMs(hb, 24 * H, NOW)).toBe(22 * H);
  });

  it("keeps the cadence after a run that failed on its own", () => {
    const hb = { lastRunAt: new Date(NOW - 2 * H), lastError: "guard held the run", meta: null };
    expect(trainingFirstRunDelayMs(hb, 24 * H, NOW)).toBe(22 * H);
  });

  it("redoes a run a graceful shutdown cut short soon after boot", () => {
    const hb = { lastRunAt: new Date(NOW - 60_000), lastError: SHUTDOWN_INTERRUPTED_ERROR, meta: null };
    expect(trainingFirstRunDelayMs(hb, 24 * H, NOW)).toBe(INTERRUPTED_RUN_RETRY_MS);
  });

  it("redoes a run whose process was killed mid-run (a start stamp with nothing after it)", () => {
    const hb = {
      lastRunAt: new Date(NOW - 6 * H),
      lastError: null,
      meta: { runningSince: new Date(NOW - 12 * 60_000).toISOString() },
    };
    expect(trainingFirstRunDelayMs(hb, 24 * H, NOW)).toBe(INTERRUPTED_RUN_RETRY_MS);
  });

  it("redoes a run the worker ended past its deadline soon after boot", () => {
    const hb = {
      lastRunAt: new Date(NOW - 60_000),
      lastError: `${DEADLINE_ERROR} after 5400s; worker restarted`,
      meta: { durationMs: 5_400_000 },
    };
    expect(trainingFirstRunDelayMs(hb, 6 * H, NOW)).toBe(INTERRUPTED_RUN_RETRY_MS);
  });

  it("redoes a run stopped from the admin panel soon after boot", () => {
    const hb = {
      lastRunAt: new Date(NOW - 60_000),
      lastError: `${STOPPED_ERROR} after 2700s; worker restarted`,
      meta: { durationMs: 2_700_000 },
    };
    expect(trainingFirstRunDelayMs(hb, 6 * H, NOW)).toBe(INTERRUPTED_RUN_RETRY_MS);
  });
});

describe("keepCadenceDelayMs", () => {
  const NOW = Date.parse("2026-10-17T04:07:39Z");
  const H = 3_600_000;
  it("waits for the slot the last run set", () => {
    expect(keepCadenceDelayMs(new Date(NOW - 24 * 60_000), H, NOW)).toBe(36 * 60_000);
  });
  it("runs now when the slot has passed or the job never ran", () => {
    expect(keepCadenceDelayMs(new Date(NOW - 2 * H), H, NOW)).toBe(0);
    expect(keepCadenceDelayMs(null, H, NOW)).toBe(0);
  });
});

describe("offsetCadenceDelayMs", () => {
  const NOW = Date.parse("2026-10-17T04:07:39Z");
  const H = 3_600_000;
  const M = 60_000;
  it("lands half an hour after the anchor job's next slot", () => {
    // wallet-risk finished 04:00: kol-side-wallets at 04:30.
    expect(offsetCadenceDelayMs(new Date(NOW - 7 * M - 39_000), H, 30 * M, NOW)).toBe(22 * M + 21_000);
  });
  it("rolls forward to the next such slot once it has passed", () => {
    // wallet-risk finished 03:20: 03:50 has passed, so 04:50.
    expect(offsetCadenceDelayMs(new Date(NOW - 47 * M - 39_000), H, 30 * M, NOW)).toBe(42 * M + 21_000);
    // Several hours behind: still within the next interval.
    expect(offsetCadenceDelayMs(new Date(NOW - 5 * H), H, 30 * M, NOW)).toBe(30 * M);
  });
  it("runs now without an anchor", () => {
    expect(offsetCadenceDelayMs(null, H, 30 * M, NOW)).toBe(0);
  });
});
