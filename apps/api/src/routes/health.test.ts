// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { publicErrorText, staleThresholdMs, summarizeHeartbeat } from "./health.js";

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
