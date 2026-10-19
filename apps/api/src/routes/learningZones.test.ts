// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

/**
 * GET /guest/insights/learning?tz=: the Week chart in the reader's zone. Each zone is a fill of
 * its own, so one caller may start fills for only a few zones a window; past that it gets the
 * UTC copy, as for a zone the server doesn't know (API audit 2026-10-19).
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("learning curve zones", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(loadEnv());
  });

  afterAll(async () => {
    await app?.close();
  });

  const ask = (tz: string, ip: string) =>
    app.inject({
      method: "GET",
      url: `/guest/insights/learning?days=7&tz=${encodeURIComponent(tz)}`,
      headers: { "cf-connecting-ip": ip },
    });

  it("fills a few zones per caller, then answers the UTC copy", async () => {
    const zones = ["Europe/Berlin", "Asia/Tokyo", "America/Lima", "Australia/Sydney", "Africa/Lagos"];
    const answered: string[] = [];
    for (const tz of zones) {
      const res = await ask(tz, "203.0.113.7");
      expect(res.statusCode).toBe(200);
      answered.push((res.json() as { timeZone: string }).timeZone);
    }
    expect(answered).toEqual([...zones.slice(0, 4), "UTC"]);
    // A zone it already has is still its own; another caller gets the fifth zone's fill.
    expect(((await ask("Asia/Tokyo", "203.0.113.7")).json() as { timeZone: string }).timeZone).toBe(
      "Asia/Tokyo",
    );
    expect(((await ask("Africa/Lagos", "203.0.113.8")).json() as { timeZone: string }).timeZone).toBe(
      "Africa/Lagos",
    );
    // Once filled, the zone is served to anyone, the over-budget caller included.
    expect(((await ask("Africa/Lagos", "203.0.113.7")).json() as { timeZone: string }).timeZone).toBe(
      "Africa/Lagos",
    );
  });
});
