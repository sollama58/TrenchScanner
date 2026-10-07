// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { bucketStart, buildLighthouseHistory, type LighthouseHistory } from "../lighthouseHistory.js";

/**
 * GET /guest/lighthouse/history and /curated/lighthouse/history: the Lighthouse's kept-for-good
 * hourly sums, added up per bucket over a window, with one label breakdown.
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Fixed "now": a Wednesday, so the week buckets are checked against a known Monday.
const NOW = new Date(Date.UTC(2023, 5, 14, 15, 30));
const LABELS = ["lhhist-a", "lhhist-b", "lhhist-c", "lhhist-d", "lhhist-e", "lhhist-f", "lhhist-g"];

async function cleanup() {
  await prisma.lighthouseHour.deleteMany({
    where: { hour: { gte: new Date(NOW.getTime() - 70 * DAY_MS), lt: new Date(NOW.getTime() + DAY_MS) } },
  });
  await prisma.lighthouseDayLabel.deleteMany({ where: { label: { in: LABELS } } });
}

describe.skipIf(!dbAvailable)("lighthouse history", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await cleanup();
    const env: Env = loadEnv();
    app = await buildServer(env);
    // Three hours of sums: two in the current week, one 10 days back (inside 30d, outside 7d),
    // and one 40 days back (the previous 30-day span).
    await prisma.lighthouseHour.createMany({
      data: [
        {
          hour: new Date(NOW.getTime() - 2 * HOUR_MS),
          screenedCalls: 10,
          screenedGraded: 8,
          screenedWon2x: 4,
          screenedTenXGraded: 6,
          screenedReturnN: 8,
          screenedReturnSum: 80,
          readsTotal: 5,
          readsDescribed: 4,
          readsDeep: 2,
          alerts: 3,
          alertsGraded: 2,
          alertsWon2x: 1,
        },
        {
          hour: new Date(NOW.getTime() - 5 * HOUR_MS),
          screenedCalls: 6,
          screenedGraded: 2,
          screenedWon2x: 2,
        },
        {
          hour: new Date(NOW.getTime() - 10 * DAY_MS),
          screenedCalls: 100,
          screenedGraded: 50,
          screenedWon2x: 10,
        },
        {
          hour: new Date(NOW.getTime() - 40 * DAY_MS),
          screenedCalls: 1000,
          screenedGraded: 500,
          screenedWon2x: 50,
        },
      ],
    });
    const today = new Date(bucketStart(NOW.getTime(), "day"));
    await prisma.lighthouseDayLabel.createMany({
      data: [
        ...LABELS.map((label, i) => ({
          day: today,
          dimension: "flag",
          label,
          count: 100 - i * 10,
          alerts: 2,
          graded: 2,
          won2x: 1,
        })),
        { day: new Date(today.getTime() - DAY_MS), dimension: "flag", label: "lhhist-a", count: 7 },
        // Another dimension's rows never leak in.
        { day: today, dimension: "pairKind", label: "lhhist-a", count: 999 },
      ],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await cleanup();
  });

  it("sums the window per bucket, zero-filled, with the span before it", async () => {
    const d = await buildLighthouseHistory({ days: 7, bucket: "day", dimension: "flag" }, NOW);
    expect(d.series).toHaveLength(8);
    expect(d.series.every((s) => typeof s.at === "string")).toBe(true);
    const today = d.series[d.series.length - 1]!;
    expect(today.screened).toMatchObject({ calls: 16, graded: 10, won2x: 6, returnSum: 80 });
    expect(today.reads).toMatchObject({ total: 5, described: 4, deep: 2 });
    expect(today.alerts).toMatchObject({ total: 3, graded: 2, won2x: 1 });
    expect(d.series[0]!.screened.calls).toBe(0);
    expect(d.totals.screened.calls).toBe(16);
    // 10 days back is outside the 7-day window but inside the 7 days before it.
    expect(d.previous?.screened.calls).toBe(100);
    expect(d.exitPlan).toMatch(/2x/);
  });

  it("buckets by week on Mondays and takes the whole history", async () => {
    const d = await buildLighthouseHistory({ days: 0, bucket: "week", dimension: "flag" }, NOW);
    expect(d.previous).toBeNull();
    const monday = new Date(Date.UTC(2023, 5, 12)).toISOString();
    const week = d.series.find((s) => s.at === monday);
    expect(week?.screened.calls).toBe(16);
    expect(d.totals.screened.calls).toBeGreaterThanOrEqual(1116);
    for (const s of d.series) expect(new Date(s.at).getUTCDay()).toBe(1);
  });

  it("keeps the biggest labels as series and folds the rest into other", async () => {
    const d = await buildLighthouseHistory({ days: 7, bucket: "hour", dimension: "flag" }, NOW);
    expect(d.labels.bucket).toBe("day");
    expect(d.labels.top).toEqual(LABELS.slice(0, 5));
    const today = d.labels.buckets[d.labels.buckets.length - 1]!;
    const other = today.rows.find((r) => r.label === "other");
    // f and g: 50 + 40.
    expect(other).toMatchObject({ count: 90, alerts: 4, won2x: 2 });
    expect(today.rows.find((r) => r.label === "lhhist-a")?.count).toBe(100);
    expect(today.rows.some((r) => r.count === 999)).toBe(false);
  });

  it("serves guests, picks a bucket for the window, and rejects what it can't draw", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/lighthouse/history?days=30" });
    expect(res.statusCode).toBe(200);
    const d = res.json<LighthouseHistory>();
    expect(d.window).toMatchObject({ days: 30, bucket: "day", dimension: "category" });
    expect(d.coverage.oldestHour).not.toBeNull();
    expect((await app.inject({ method: "GET", url: "/guest/lighthouse/history?days=12" })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: "GET", url: "/guest/lighthouse/history?days=365&bucket=hour" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/guest/lighthouse/history?dimension=mint" })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/curated/lighthouse/history" })).statusCode).toBe(401);
  });

  it("starts week buckets on Monday", () => {
    expect(new Date(bucketStart(NOW.getTime(), "week")).toISOString()).toBe("2023-06-12T00:00:00.000Z");
    expect(new Date(bucketStart(Date.UTC(2023, 5, 12), "week")).toISOString()).toBe(
      "2023-06-12T00:00:00.000Z",
    );
    expect(new Date(bucketStart(Date.UTC(2023, 5, 11, 23), "week")).toISOString()).toBe(
      "2023-06-05T00:00:00.000Z",
    );
  });
});
