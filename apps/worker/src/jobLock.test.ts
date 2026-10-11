// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { prisma, type HeartbeatJob } from "@trenchscanner/core";
import { jobLockKey, withJobLock } from "./jobLock.js";
import { JobSkipped } from "./scheduler.js";

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
