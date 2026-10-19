import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./db.js";
import {
  HEARTBEAT_JOB_ROLE,
  lastRebuiltAt,
  lockLostDuringRun,
  recordHeartbeat,
  recordRunStart,
  runningSinceFrom,
  runsJob,
  type HeartbeatJob,
} from "./heartbeat.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("runningSinceFrom", () => {
  it("reads a stamped start back, and nothing from anything else", () => {
    expect(runningSinceFrom({ runningSince: "2026-10-03T20:33:00.000Z" })?.toISOString()).toBe(
      "2026-10-03T20:33:00.000Z",
    );
    expect(runningSinceFrom({ durationMs: 5 })).toBeNull();
    expect(runningSinceFrom({ runningSince: "not a date" })).toBeNull();
    expect(runningSinceFrom(null)).toBeNull();
    expect(runningSinceFrom(["runningSince"])).toBeNull();
  });

  it("ignores a stamp left behind by a run that has since finished (an interrupted-at-shutdown heartbeat)", () => {
    const meta = { runningSince: "2026-10-03T20:33:00.000Z" };
    expect(runningSinceFrom(meta, new Date("2026-10-03T20:40:00.000Z"))).toBeNull();
    expect(runningSinceFrom(meta, new Date("2026-10-03T18:00:00.000Z"))?.toISOString()).toBe(
      "2026-10-03T20:33:00.000Z",
    );
  });
});

describe.skipIf(!dbAvailable)("recordRunStart", () => {
  // A job name the worker never uses, so the suite can't disturb a real row.
  const job = "heartbeat-test" as HeartbeatJob;

  afterAll(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job } });
  });

  it("marks a run in flight without moving lastRunAt, and the finished run clears it", async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job } });
    await recordHeartbeat(job, { success: true, meta: { durationMs: 1_000 } });
    const before = await prisma.systemHeartbeat.findUniqueOrThrow({ where: { job } });

    const startedAt = new Date("2026-10-03T20:33:00.000Z");
    await recordRunStart(job, startedAt);
    const running = await prisma.systemHeartbeat.findUniqueOrThrow({ where: { job } });
    expect(running.lastRunAt.getTime()).toBe(before.lastRunAt.getTime());
    expect(runningSinceFrom(running.meta)?.getTime()).toBe(startedAt.getTime());
    // The previous run's timing survives until the new run replaces it.
    expect((running.meta as { durationMs?: number }).durationMs).toBe(1_000);

    await recordHeartbeat(job, { success: true, meta: { durationMs: 2_000 } });
    const done = await prisma.systemHeartbeat.findUniqueOrThrow({ where: { job } });
    expect(runningSinceFrom(done.meta)).toBeNull();
  });

  it("keeps an error on a successful run only when one is given", async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job } });
    await recordHeartbeat(job, { success: false, error: "boom" });
    await recordHeartbeat(job, { success: true, error: "1 stage failed" });
    const partial = await prisma.systemHeartbeat.findUniqueOrThrow({ where: { job } });
    expect(partial.lastSuccessAt).not.toBeNull();
    expect(partial.lastError).toBe("1 stage failed");
    await recordHeartbeat(job, { success: true });
    expect((await prisma.systemHeartbeat.findUniqueOrThrow({ where: { job } })).lastError).toBeNull();
  });

  it("is a no-op for a job with no row yet", async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job } });
    await recordRunStart(job);
    expect(await prisma.systemHeartbeat.findUnique({ where: { job } })).toBeNull();
  });

  it("reads a rebuilt table's last rebuild as the later of a row's stamp and the last good run", async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job } });
    const row = new Date(Date.now() - 3_600_000);
    // No heartbeat yet: the row's own stamp.
    expect(await lastRebuiltAt(job, row)).toEqual(row);
    expect(await lastRebuiltAt(job, null)).toBeNull();
    // A later run that changed nothing: the run.
    await recordHeartbeat(job, { success: true });
    const ran = (await prisma.systemHeartbeat.findUniqueOrThrow({ where: { job } })).lastSuccessAt!;
    expect(await lastRebuiltAt(job, row)).toEqual(ran);
    // A row stamped after the heartbeat (the run that wrote it hasn't recorded yet): the row.
    const newer = new Date(ran.getTime() + 60_000);
    expect(await lastRebuiltAt(job, newer)).toEqual(newer);
  });
});

describe("worker roles", () => {
  it("gives every job to exactly one process, and 'all' runs them all", () => {
    const jobs = Object.keys(HEARTBEAT_JOB_ROLE) as (keyof typeof HEARTBEAT_JOB_ROLE)[];
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(runsJob("all", job)).toBe(true);
      const owners = (["scanner", "trainer", "trader"] as const).filter((role) => runsJob(role, job));
      expect(owners).toHaveLength(1);
    }
    // The alert path stays with the scanner; the batch work goes to the trainer.
    expect(runsJob("scanner", "scan")).toBe(true);
    expect(runsJob("scanner", "candidate-watch")).toBe(true);
    expect(runsJob("trainer", "curator-training")).toBe(true);
    expect(runsJob("trainer", "champion-refresh")).toBe(true);
    expect(runsJob("scanner", "curator-training")).toBe(false);
    // The trading bot has a process to itself.
    expect(runsJob("trader", "trading-bot")).toBe(true);
    expect(runsJob("trader", "scan")).toBe(false);
    expect(runsJob("scanner", "trading-bot")).toBe(false);
  });
});

describe("lockLostDuringRun", () => {
  const since = new Date("2026-10-19T03:00:00.000Z");
  it("is a lock lost after the run in flight started, and nothing else", () => {
    expect(lockLostDuringRun({ lockLostAt: "2026-10-19T03:20:00.000Z" }, since)).toBe(true);
    // Left from an earlier run: says nothing about this one.
    expect(lockLostDuringRun({ lockLostAt: "2026-10-18T03:20:00.000Z" }, since)).toBe(false);
    expect(lockLostDuringRun({ lockLostAt: "2026-10-19T03:20:00.000Z" }, null)).toBe(false);
    expect(lockLostDuringRun({ runningSince: since.toISOString() }, since)).toBe(false);
    expect(lockLostDuringRun(null, since)).toBe(false);
  });
});
