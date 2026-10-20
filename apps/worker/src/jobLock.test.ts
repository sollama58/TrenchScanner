// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { prisma, type HeartbeatJob } from "@trenchscanner/core";
import { JOB_LOCK_APPLICATION_NAME, jobLockKey, withJobLock } from "./jobLock.js";
import { JobLockLost, JobSkipped } from "./scheduler.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

// A job name the worker never uses, so a concurrent test run against the same database (or a
// worker running locally) can't hold the lock this suite takes.
const job = "job-lock-test" as HeartbeatJob;

describe.skipIf(!dbAvailable)("withJobLock", () => {
  it("runs the job when the lock is free, and lets go of it after", async () => {
    expect(await withJobLock(job, async () => "ran")).toBe("ran");
    // Released: a second run takes it again.
    expect(await withJobLock(job, async () => "again")).toBe("again");
  });

  it("skips the run while another session holds the lock, and releases it when the job throws", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtext($1))", [jobLockKey(job)]);
      let ran = false;
      await expect(
        withJobLock(job, async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(JobSkipped);
      expect(ran).toBe(false);
      await other.query("SELECT pg_advisory_unlock(hashtext($1))", [jobLockKey(job)]);
    } finally {
      await other.end();
    }

    await expect(
      withJobLock(job, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withJobLock(job, async () => "free")).toBe("free");
  });

  it("stops a run that must not continue once another session holds its lock", async () => {
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    const killer = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    await killer.connect();
    const otherPid = (await other.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const run = withJobLock(
      job,
      (signal) => {
        markStarted();
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("lock was not lost")), 10_000);
          const finish = () => {
            clearTimeout(timer);
            resolve("stopped");
          };
          if (signal.aborted) return finish();
          signal.addEventListener("abort", finish, { once: true });
        });
      },
      { stopWhenLockLost: true },
    );
    try {
      await started;
      const held = await killer.query<{ pid: number }>(
        `SELECT a.pid
         FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid = a.pid
         WHERE a.application_name = $2
           AND l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
           AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext($1)::bigint`,
        [jobLockKey(job), JOB_LOCK_APPLICATION_NAME],
      );
      expect(held.rows.length).toBeGreaterThan(0);
      // Queue for the lock before the holder's connection dies, so this session is granted it
      // ahead of the run's attempt to take the lock again.
      const waiting = other.query("SELECT pg_advisory_lock(hashtext($1))", [jobLockKey(job)]);
      const deadline = Date.now() + 5_000;
      let queued = false;
      while (Date.now() < deadline) {
        const q = await killer.query(
          `SELECT 1 FROM pg_locks l
           WHERE l.pid = $1 AND l.locktype = 'advisory' AND NOT l.granted
             AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext($2)::bigint`,
          [otherPid, jobLockKey(job)],
        );
        if (q.rowCount) {
          queued = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(queued).toBe(true);
      const terminated = await killer.query<{ ok: boolean }>("SELECT pg_terminate_backend($1::int) AS ok", [
        held.rows[0]!.pid,
      ]);
      expect(terminated.rows[0]!.ok).toBe(true);
      await waiting;
      await expect(run).rejects.toBeInstanceOf(JobLockLost);
    } finally {
      await other.query("SELECT pg_advisory_unlock(hashtext($1))", [jobLockKey(job)]).catch(() => {});
      await other.end().catch(() => {});
      await killer.end().catch(() => {});
    }
    expect(await withJobLock(job, async () => "free")).toBe("free");
  });

  it("holds the lock for the whole run", async () => {
    let skippedInside = false;
    await withJobLock(job, async () => {
      await withJobLock(job, async () => {}).catch((err) => {
        skippedInside = err instanceof JobSkipped;
      });
    });
    expect(skippedInside).toBe(true);
  });
});
