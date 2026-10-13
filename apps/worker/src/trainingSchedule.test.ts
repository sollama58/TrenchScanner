import { describe, expect, it } from "vitest";
import { INTERRUPTED_RUN_RETRY_MS, trainingFirstRunDelayMs } from "./trainingSchedule.js";
import { SHUTDOWN_INTERRUPTED_ERROR } from "./scheduler.js";

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
});
