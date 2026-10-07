// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { publicErrorText, summarizeHeartbeat } from "./health.js";

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
