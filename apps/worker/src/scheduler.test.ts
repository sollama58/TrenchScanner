import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heartbeats: { job: string; success: boolean; meta?: unknown }[] = [];
const starts: string[] = [];

vi.mock("@trenchscanner/core", () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
  recordHeartbeat: async (job: string, result: { success: boolean; meta?: unknown }) => {
    heartbeats.push({ job, ...result });
  },
  recordRunStart: async (job: string) => {
    starts.push(job);
  },
}));

const { scheduleInterval } = await import("./scheduler.js");

/** A job whose every run takes `ms` of (fake) time. */
function jobTaking(ms: number, runs: number[]) {
  return async () => {
    runs.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
}

describe("scheduleInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    heartbeats.length = 0;
    starts.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the configured cadence when runs finish inside the interval", async () => {
    const runs: number[] = [];
    const job = scheduleInterval("scan", jobTaking(10_000, runs), 1);
    await vi.advanceTimersByTimeAsync(185_000);
    job.stop();
    expect(runs).toEqual([0, 60_000, 120_000, 180_000]);
  });

  it("starts the next run as soon as an overrunning one finishes, not a whole interval later", async () => {
    // A 70s cycle on a 60s timer: the old skip-a-tick setInterval ran it at 0, 120, 240...
    const runs: number[] = [];
    const job = scheduleInterval("scan", jobTaking(70_000, runs), 1);
    await vi.advanceTimersByTimeAsync(215_000);
    job.stop();
    // (Fake timers fire a 0ms timeout 1ms later, hence the tolerance.)
    expect(runs).toHaveLength(4);
    runs.slice(1).forEach((at, i) => expect(at - runs[i]!).toBeLessThan(70_010));
  });

  it("never overlaps runs", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const job = scheduleInterval(
      "fast-match",
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40_000));
        inFlight -= 1;
      },
      0.25,
    );
    await vi.advanceTimersByTimeAsync(200_000);
    job.stop();
    expect(maxInFlight).toBe(1);
  });

  it("stamps the run start and stores the job's own meta with the duration", async () => {
    const job = scheduleInterval(
      "scan",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { stagesMs: { discovery: 5_000 } };
      },
      1,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    job.stop();
    expect(starts).toEqual(["scan"]);
    expect(heartbeats).toEqual([
      { job: "scan", success: true, meta: { stagesMs: { discovery: 5_000 }, durationMs: 5_000 } },
    ]);
  });

  it("keeps running after a failed run, and records the failure", async () => {
    let calls = 0;
    const job = scheduleInterval(
      "scan",
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      1,
    );
    await vi.advanceTimersByTimeAsync(61_000);
    job.stop();
    expect(calls).toBe(2);
    expect(heartbeats[0]).toMatchObject({ job: "scan", success: false, error: "Error: boom" });
    expect(heartbeats[1]).toMatchObject({ job: "scan", success: true });
  });

  it("stops scheduling once stopped", async () => {
    const runs: number[] = [];
    const job = scheduleInterval("scan", jobTaking(1_000, runs), 1);
    await vi.advanceTimersByTimeAsync(2_000);
    job.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runs).toEqual([0]);
  });
});
