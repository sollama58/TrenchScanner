// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv, prisma } from "@trenchscanner/core";
import { buildServer } from "./server.js";

/**
 * A database outage surfaced the raw Prisma message - internal hostname included - on every
 * routed 500, because the error handler was set after the route plugins had been registered.
 */
describe("route errors", () => {
  const appPromise = buildServer(loadEnv());

  afterAll(async () => {
    vi.restoreAllMocks();
    await (await appPromise).close();
  });

  it("answers a failing route with a generic body", async () => {
    vi.spyOn(prisma.systemHeartbeat, "findMany").mockRejectedValue(
      new Error("Can't reach database server at `dpg-internal-host:5432`"),
    );
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/health/worker" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.body).not.toContain("dpg-internal-host");
  });
});
