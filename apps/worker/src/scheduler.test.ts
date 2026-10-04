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
  lastHeartbeatAt: async () => null,
}));

const { scheduleInterval, scheduleDailyAt } = await import("./scheduler.js");

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

  it("calls onDeadline for a run that never returns, and not for one that does", async () => {
    const hits: [string, number][] = [];
    const onDeadline = (job: string, ms: number) => void hits.push([job, ms]);
    const hung = scheduleInterval("scan", () => new Promise(() => {}), 1, {
      deadlineMinutes: 20,
      onDeadline,
    });
    const fine = scheduleInterval("fast-match", jobTaking(10_000, []), 0.25, {
      deadlineMinutes: 1,
      onDeadline,
    });
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    hung.stop();
    fine.stop();
    expect(hits).toEqual([["scan", 20 * 60_000]]);
  });

  it("does not count a blocked event loop against the deadline", async () => {
    const hits: string[] = [];
    let release!: () => void;
    const job = scheduleInterval("fast-match", () => new Promise<void>((r) => (release = r)), 0.25, {
      deadlineMinutes: 10,
      onDeadline: (j) => void hits.push(j),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    // Twelve minutes pass with no timer able to fire, as during a long synchronous retrain.
    vi.setSystemTime(Date.now() + 12 * 60_000);
    await vi.advanceTimersByTimeAsync(15_000);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    job.stop();
    expect(hits).toEqual([]);
  });

  it("holds the first run for firstRunDelayMs, then keeps its cadence", async () => {
    const runs: number[] = [];
    const job = scheduleInterval("curator-training", jobTaking(1_000, runs), 10, {
      firstRunDelayMs: async () => 300_000,
    });
    await vi.advanceTimersByTimeAsync(1_000_000);
    job.stop();
    expect(runs).toEqual([300_000, 900_000]);
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

describe("scheduleDailyAt", () => {
  const HOUR = 3_600_000;
  // 2026-10-03 10:00 UTC
  const T0 = Date.UTC(2026, 9, 3, 10, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    heartbeats.length = 0;
    starts.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for its hour when the last run is recent", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt("cleanup", async () => void runs.push(Date.now()), 4, {
      catchUpAfterHours: 26,
      lastRunAt: async () => new Date(T0 - 6 * HOUR),
    });
    await vi.advanceTimersByTimeAsync(17 * HOUR + 1_000);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    job.stop();
    expect(runs).toEqual([Date.UTC(2026, 9, 4, 4, 0, 0)]);
  });

  it("runs straight away when overdue, then settles onto its hour", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt("cleanup", async () => void runs.push(Date.now()), 4, {
      catchUpAfterHours: 26,
      lastRunAt: async () => new Date(T0 - 13 * 24 * HOUR),
    });
    await vi.advanceTimersByTimeAsync(19 * HOUR);
    job.stop();
    expect(runs).toEqual([T0, Date.UTC(2026, 9, 4, 4, 0, 0)]);
  });

  it("catches up a job that has never run", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt("cleanup", async () => void runs.push(Date.now()), 4, {
      catchUpAfterHours: 26,
      lastRunAt: async () => null,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    job.stop();
    expect(runs).toEqual([T0]);
  });

  it("keeps the ordinary schedule when the last run can't be read", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt("cleanup", async () => void runs.push(Date.now()), 4, {
      catchUpAfterHours: 26,
      lastRunAt: async () => {
        throw new Error("db down");
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    job.stop();
    expect(runs).toEqual([]);
  });

  it("asks again when the last run can't be read, and catches up once it can", async () => {
    const runs: number[] = [];
    let reads = 0;
    const job = scheduleDailyAt("cleanup", async () => void runs.push(Date.now()), 4, {
      catchUpAfterHours: 26,
      lastRunAt: async () => {
        reads += 1;
        if (reads === 1) throw new Error("db down");
        return null;
      },
    });
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    job.stop();
    expect(runs).toEqual([T0 + 30 * 60_000]);
  });

  it("retries a failed run after half an hour, up to three times, then waits for its hour", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt(
      "outcome-tracking",
      async () => {
        runs.push(Date.now());
        throw new Error("Can't reach database server");
      },
      5,
      { catchUpAfterHours: 26, lastRunAt: async () => null },
    );
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    job.stop();
    const MIN = 60_000;
    expect(runs).toEqual([T0, T0 + 30 * MIN, T0 + 60 * MIN, T0 + 90 * MIN]);
  });

  it("goes back to its daily slot once a retry succeeds", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt(
      "outcome-tracking",
      async () => {
        runs.push(Date.now());
        if (runs.length === 1) throw new Error("blip");
      },
      5,
      { catchUpAfterHours: 26, lastRunAt: async () => null },
    );
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    job.stop();
    expect(runs).toEqual([T0, T0 + 30 * 60_000, Date.UTC(2026, 9, 4, 5, 0, 0)]);
  });

  it("never stacks a run that overruns its day - the next one takes the following slot", async () => {
    const runs: number[] = [];
    const job = scheduleDailyAt(
      "outcome-tracking",
      async () => {
        runs.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 30 * HOUR));
      },
      5,
    );
    // First slot 2026-10-04 05:00, runs until 10-05 11:00; next slot is 10-06 05:00.
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    job.stop();
    expect(runs).toEqual([Date.UTC(2026, 9, 4, 5, 0, 0), Date.UTC(2026, 9, 6, 5, 0, 0)]);
    expect(heartbeats[0]).toMatchObject({
      job: "outcome-tracking",
      success: true,
      meta: { durationMs: 30 * HOUR },
    });
  });
});
