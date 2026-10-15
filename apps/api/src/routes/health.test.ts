// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  publicErrorText,
  staleThresholdMs,
  STRICT_WORKER_JOBS,
  strictWorkerFailures,
  summarizeHeartbeat,
} from "./health.js";

/**
 * GET /health/worker needs no sign-in, so a job's last error reaches it without the hosts and
 * URLs the worker's own log carries; the admin route keeps the full text.
 */
describe("public worker health: error text", () => {
  it("blanks the database host and upstream URLs, and keeps the first line only", () => {
    expect(
      publicErrorText(
        "Can't reach database server at `dpg-abc123-a.oregon-postgres.render.com:5432`\nPlease make sure your database server is running",
      ),
    ).toBe("Can't reach database server at `<host>`");
    expect(publicErrorText("HttpError: HTTP 502 for https://api.rugcheck.xyz/v1/tokens/abc/report")).toBe(
      "HttpError: HTTP 502 for <url>",
    );
    expect(publicErrorText("Timed out fetching a new connection from the pool")).toBe(
      "Timed out fetching a new connection from the pool",
    );
    expect(publicErrorText("x".repeat(400))).toHaveLength(300);
  });

  it("blanks the engine's split host`:`port form and bare hostnames too", () => {
    expect(
      publicErrorText("Can't reach database server at `dpg-abc123-a.oregon-postgres.render.com`:`5432`"),
    ).toBe("Can't reach database server at <host>");
    expect(publicErrorText("getaddrinfo ENOTFOUND dpg-abc123-a.oregon-postgres.render.com")).toBe(
      "getaddrinfo ENOTFOUND <host>",
    );
  });

  it("is applied on the public summary and not the admin one", () => {
    const row = {
      job: "scan",
      lastRunAt: new Date(1_000),
      lastSuccessAt: null,
      lastError: "Can't reach database server at `db.internal:5432`",
      meta: null,
    };
    const h = (opts?: { fullError?: boolean }) =>
      summarizeHeartbeat(row as unknown as Parameters<typeof summarizeHeartbeat>[0], 2_000, opts).lastError;
    expect(h()).toBe("Can't reach database server at `<host>`");
    expect(h({ fullError: true })).toBe(row.lastError);
  });
});

/**
 * The worker's intervals are env-tunable, so the stale threshold follows the cadence each job's
 * own heartbeat reports rather than a table that would drift from the env.
 */
describe("public worker health: stale threshold", () => {
  it("is the table's figure for a row that reports no cadence", () => {
    expect(staleThresholdMs("curator-training", null)).toBe(4 * 3_600_000);
    expect(staleThresholdMs("curator-training", { durationMs: 10 })).toBe(4 * 3_600_000);
    expect(staleThresholdMs("never-heard-of-it", null)).toBe(30 * 60_000);
  });

  it("follows a reported interval, never below the table's floor", () => {
    // Training set to every 6 hours: the table's 4 hours would call every run stale.
    expect(staleThresholdMs("curator-training", { intervalMs: 6 * 3_600_000 })).toBe(18 * 3_600_000);
    // Scan every minute: three minutes is below the table's ten, so the floor holds.
    expect(staleThresholdMs("scan", { intervalMs: 60_000 })).toBe(10 * 60_000);
    // A daily job reports its slot, not an interval: the table's day-plus already fits it.
    expect(staleThresholdMs("cleanup", { dailyAtHourUtc: 4 })).toBe(26 * 3_600_000);
    // Garbage is ignored rather than trusted.
    expect(staleThresholdMs("scan", { intervalMs: -5 })).toBe(10 * 60_000);
    expect(staleThresholdMs("scan", { intervalMs: "soon" })).toBe(10 * 60_000);
  });

  it("is what the summary reports, and the cadence stays out of lastRun", () => {
    const row = {
      job: "curator-training",
      lastRunAt: new Date(0),
      lastSuccessAt: null,
      lastError: null,
      meta: { durationMs: 1_000, intervalMs: 6 * 3_600_000 },
    };
    const summary = summarizeHeartbeat(
      row as unknown as Parameters<typeof summarizeHeartbeat>[0],
      5 * 3_600_000,
    );
    expect(summary.staleAfterMs).toBe(18 * 3_600_000);
    expect(summary.stale).toBe(false);
    expect(summary.lastRun).toEqual({ durationMs: 1_000 });
  });
});

describe("public worker health: a training run in flight", () => {
  const row = (runningMin: number) => ({
    job: "curator-training",
    lastRunAt: new Date(0),
    lastSuccessAt: new Date(0),
    lastError: null,
    meta: {
      intervalMs: 6 * 3_600_000,
      runningSince: new Date(3_600_000 - runningMin * 60_000).toISOString(),
      runningStagesMs: { "load rows": 40_000, plan: 2_000 },
      runningStep: "exams: examining Trees (5 of up to 24)",
      runningStepAt: new Date(3_600_000 - 60_000).toISOString(),
    },
  });
  const at = (runningMin: number) =>
    summarizeHeartbeat(row(runningMin) as unknown as Parameters<typeof summarizeHeartbeat>[0], 3_600_000);

  it("reports the stages done and the step under way", () => {
    const s = at(12);
    expect(s.runningForMs).toBe(12 * 60_000);
    expect(s.runningStagesMs).toEqual({ "load rows": 40_000, plan: 2_000 });
    expect(s.runningStep).toEqual({
      step: "exams: examining Trees (5 of up to 24)",
      since: new Date(3_600_000 - 60_000).toISOString(),
    });
  });

  it("is hung after 45 minutes, long before its 18-hour stale threshold", () => {
    expect(at(44).hung).toBe(false);
    expect(at(46).hung).toBe(true);
    expect(at(46).staleAfterMs).toBe(18 * 3_600_000);
  });
});

/** The scan's TokenSage counters reach the public summary, numbers only. */
describe("public worker health: TokenSage counters", () => {
  it("carries the scan's tokensage counts and drops anything that isn't a number", () => {
    const row = {
      job: "scan",
      lastRunAt: new Date(1_000),
      lastSuccessAt: null,
      lastError: null,
      meta: { durationMs: 900, tokensage: { requested: 12, stored: 3, pending: 40, mint: "abc" } },
    };
    const s = summarizeHeartbeat(row as unknown as Parameters<typeof summarizeHeartbeat>[0], 2_000);
    expect(s.lastRun).toMatchObject({
      durationMs: 900,
      tokensage: { requested: 12, stored: 3, pending: 40 },
    });
    expect((s.lastRun as { tokensage: Record<string, unknown> }).tokensage).not.toHaveProperty("mint");
  });
});

/** The scan's launch-buyer read counts reach the public summary too. */
describe("public worker health: snipers share reads", () => {
  it("carries the scan's sniperReads counts", () => {
    const row = {
      job: "scan",
      lastRunAt: new Date(1_000),
      lastSuccessAt: null,
      lastError: null,
      meta: { durationMs: 900, sniperReads: { requested: 6, found: 5, failed: 1 } },
    };
    const s = summarizeHeartbeat(row as unknown as Parameters<typeof summarizeHeartbeat>[0], 2_000);
    expect(s.lastRun).toMatchObject({ sniperReads: { requested: 6, found: 5, failed: 1 } });
  });
});

/** Who priced the newest launches, and the band-entry checks between cycles, reach it too. */
describe("public worker health: live launch prices and band-entry checks", () => {
  it("carries the scan's liveLaunchQuotes, bandEntryWatch and rugCheckLookups counts", () => {
    const liveLaunchQuotes = { asked: 40, jupiter: 38, backupAsked: 2, backup: 1, unpriced: 1 };
    const bandEntryWatch = { checks: 4, wakes: 1, newLaunchWakes: 1 };
    const rugCheckLookups = { requested: 600, cached: 560, fetched: 12, failed: 1, timedOut: 1, reused: 27 };
    const row = {
      job: "scan",
      lastRunAt: new Date(1_000),
      lastSuccessAt: null,
      lastError: null,
      meta: { durationMs: 900, liveLaunchQuotes, bandEntryWatch, rugCheckLookups },
    };
    const s = summarizeHeartbeat(row as unknown as Parameters<typeof summarizeHeartbeat>[0], 2_000);
    expect(s.lastRun).toMatchObject({ liveLaunchQuotes, bandEntryWatch, rugCheckLookups });
  });
});

/** Pump.fun's coin list and the one-coin fallback reach it, with the list's last failure. */
describe("public worker health: Pump.fun list and launch details", () => {
  it("carries pumpfunList with its last error, and launchDetails", () => {
    const pumpfunList = {
      pages: 9,
      failed: 9,
      lastError: "HTTP 403 (blocked - likely a Cloudflare challenge)",
    };
    const launchDetails = { asked: 12, fromPumpFun: 11, fromMetadata: 1, missing: 0, dropped: 0 };
    const row = {
      job: "scan",
      lastRunAt: new Date(1_000),
      lastSuccessAt: null,
      lastError: null,
      meta: { durationMs: 900, pumpfunList, launchDetails },
    };
    const s = summarizeHeartbeat(row as unknown as Parameters<typeof summarizeHeartbeat>[0], 2_000);
    expect(s.lastRun).toMatchObject({ pumpfunList, launchDetails });
  });
});

/** A run that did nothing says why, so a reviewer with no key doesn't read as a healthy success. */
describe("public worker health: skipped runs", () => {
  it("carries the job's skipped reason", () => {
    const row = {
      job: "ai-judge",
      lastRunAt: new Date(1_000),
      lastSuccessAt: new Date(1_000),
      lastError: null,
      meta: { durationMs: 6, skipped: "reviewer off" },
    };
    const s = summarizeHeartbeat(row as unknown as Parameters<typeof summarizeHeartbeat>[0], 2_000);
    expect(s.lastRun).toEqual({ durationMs: 6, skipped: "reviewer off" });
  });
});

describe("GET /health while the report caches fill", () => {
  it("answers 503 until warming ends, then 200", async () => {
    const { default: Fastify } = await import("fastify");
    const { registerHealthRoutes } = await import("./health.js");
    let warming = true;
    const app = Fastify();
    await app.register(registerHealthRoutes, { prefix: "/health", warming: () => warming });
    expect((await app.inject({ url: "/health" })).statusCode).toBe(503);
    warming = false;
    const res = await app.inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

/**
 * `?strict=1` puts the alert path's staleness into the status code, for an outside uptime
 * monitor that reads nothing else; without it the route answers 200 exactly as before.
 */
describe("GET /health/worker?strict=1: which jobs fail it", () => {
  const fresh = (job: string) => ({ job, stale: false });

  it("passes when every alert-path job and the scanner's pulse are fresh", () => {
    expect(strictWorkerFailures(STRICT_WORKER_JOBS.map(fresh))).toEqual([]);
  });

  it("names a stale alert-path job, and ignores stale jobs off the alert path", () => {
    const jobs = [
      ...STRICT_WORKER_JOBS.map((job) => (job === "fast-match" ? { job, stale: true } : fresh(job))),
      { job: "cleanup", stale: true },
      { job: "curator-training", stale: true },
    ];
    expect(strictWorkerFailures(jobs)).toEqual(["fast-match"]);
  });

  it("counts a missing row as failing: the scanner never wrote one", () => {
    const jobs = STRICT_WORKER_JOBS.filter((j) => j !== "pipeline-watch").map(fresh);
    expect(strictWorkerFailures(jobs)).toEqual(["pipeline-watch"]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("GET /health/worker?strict=1 against the database", () => {
  const app = async () => {
    const { default: Fastify } = await import("fastify");
    const { registerHealthRoutes } = await import("./health.js");
    const instance = Fastify();
    await instance.register(registerHealthRoutes, { prefix: "/health" });
    return instance;
  };
  const ranAt = (at: Date) =>
    Promise.all(
      STRICT_WORKER_JOBS.map((job) =>
        prisma.systemHeartbeat.upsert({
          where: { job },
          create: { job, lastRunAt: at },
          update: { lastRunAt: at, meta: {} },
        }),
      ),
    );

  it("answers 200 while the alert path is fresh, 503 naming the stale job once it isn't", async () => {
    await ranAt(new Date());
    const first = await app();
    const ok = await first.inject({ url: "/health/worker?strict=1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ failing: [] });
    await first.close();

    await prisma.systemHeartbeat.update({
      where: { job: "scan" },
      data: { lastRunAt: new Date(Date.now() - 60 * 60_000) },
    });
    // A fresh instance, so the five-second heartbeat cache doesn't answer from the first read.
    const second = await app();
    const bad = await second.inject({ url: "/health/worker?strict=1" });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ failing: ["scan"] });
    expect(bad.json().jobs.find((j: { job: string }) => j.job === "scan").stale).toBe(true);

    // Without strict: the same staleness, still a 200, and the body as it always was.
    const plain = await second.inject({ url: "/health/worker" });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).not.toHaveProperty("failing");
    await second.close();
    await ranAt(new Date());
  });
});
