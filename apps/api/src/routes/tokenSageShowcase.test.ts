// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildTokenSageShowcase, topLabels } from "../tokenSageShowcase.js";

/**
 * GET /guest/tokensage: the /tokensage page's aggregates - the rollup's sums kept for good and
 * counts over the TokenNarrative rows still kept, with no coin named.
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Before every other test's rollup rows (2021 onwards), so the all-time sums here are exact.
const NOW = new Date(Date.UTC(2019, 2, 14, 15, 30));
const TODAY = new Date(Date.UTC(2019, 2, 14));
const MINTS = ["tssMintA", "tssMintB", "tssMintC", "tssMintD"];

async function cleanup() {
  await prisma.lighthouseHour.deleteMany({ where: { hour: { lt: new Date(Date.UTC(2020, 0, 1)) } } });
  await prisma.lighthouseDayLabel.deleteMany({ where: { day: { lt: new Date(Date.UTC(2020, 0, 1)) } } });
  await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { in: MINTS } } });
}

describe("topLabels", () => {
  it("keeps the biggest labels and sums the rest into other", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      label: `l${i}`,
      count: 10 - i,
      alerts: 1,
      graded: 1,
      won2x: i % 2,
    }));
    const top = topLabels(rows, 3);
    expect(top.map((r) => r.label)).toEqual(["l0", "l1", "l2", "other"]);
    expect(top[3]).toEqual({ label: "other", count: 28, alerts: 7, graded: 7, won2x: 4 });
    expect(topLabels(rows.slice(0, 2), 3)).toHaveLength(2);
  });
});

describe.skipIf(!dbAvailable)("tokensage showcase", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await cleanup();
    const env: Env = loadEnv();
    app = await buildServer(env);
    await prisma.lighthouseHour.createMany({
      data: [
        {
          hour: new Date(NOW.getTime() - 2 * HOUR_MS),
          readsTotal: 10,
          readsDescribed: 8,
          readsDeep: 3,
          readsFailed: 1,
          referentConfidenceSum: 3,
          referentConfidenceN: 4,
          xFitSum: 1.5,
          xFitN: 2,
          copiesRecent: 2,
          copiesAnswered: 5,
          alerts: 4,
          alertsDescribed: 3,
          alertsGraded: 2,
          alertsWon2x: 1,
        },
        { hour: new Date(NOW.getTime() - 5 * DAY_MS), readsTotal: 6, readsDescribed: 6, readsDeep: 1 },
        // Outside the last 24 hours: in the totals only.
        { hour: new Date(NOW.getTime() - 60 * DAY_MS), readsTotal: 100, readsDescribed: 90 },
      ],
    });
    await prisma.lighthouseDayLabel.createMany({
      data: [
        { day: TODAY, dimension: "category", label: "animal", count: 5, alerts: 2, graded: 2, won2x: 1 },
        { day: new Date(TODAY.getTime() - DAY_MS), dimension: "category", label: "animal", count: 3 },
        { day: TODAY, dimension: "category", label: "celebrity", count: 7 },
        { day: TODAY, dimension: "copy", label: "original", count: 4, alerts: 1, graded: 1, won2x: 1 },
      ],
    });
    await prisma.tokenNarrative.createMany({
      data: [
        {
          mintAddress: MINTS[0]!,
          depth: "full",
          status: "complete",
          lineageKind: "tss-original",
          logoLabel: "tss-dog",
        },
        { mintAddress: MINTS[1]!, depth: "full", status: "complete", lineageKind: "tss-original" },
        { mintAddress: MINTS[2]!, depth: "basic", status: "complete", lineageKind: "tss-late-copy" },
        // Failed reads describe nothing.
        { mintAddress: MINTS[3]!, depth: "basic", status: "failed", lineageKind: "tss-original" },
      ],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await cleanup();
  });

  it("sums every read kept", async () => {
    const d = await buildTokenSageShowcase(NOW);
    expect(d.totals).toMatchObject({
      reads: 116,
      described: 104,
      deep: 4,
      failed: 1,
      alerts: 4,
      alertsWon2x: 1,
    });
    expect(d.totals.avgReferentConfidence).toBeCloseTo(0.75);
    expect(d.totals.avgXFit).toBeCloseTo(0.75);
    expect(d.since).toEqual(new Date(NOW.getTime() - 60 * DAY_MS));
    expect(d.last24h).toEqual({ reads: 10, described: 8, deep: 3 });
  });

  it("totals each label over every day, biggest first", async () => {
    const d = await buildTokenSageShowcase(NOW);
    expect(d.labels.category).toEqual([
      { label: "animal", count: 8, alerts: 2, graded: 2, won2x: 1 },
      { label: "celebrity", count: 7, alerts: 0, graded: 0, won2x: 0 },
    ]);
    expect(d.labels.copy).toEqual([{ label: "original", count: 4, alerts: 1, graded: 1, won2x: 1 }]);
    expect(d.labels.flag).toEqual([]);
  });

  it("counts the kept reads' parts, leaving failed reads out", async () => {
    const d = await buildTokenSageShowcase(NOW);
    expect(d.anatomy.lineage).toContainEqual({ label: "tss-original", count: 2 });
    expect(d.anatomy.lineage).toContainEqual({ label: "tss-late-copy", count: 1 });
    expect(d.anatomy.logo).toContainEqual({ label: "tss-dog", count: 1 });
    expect(Object.keys(d.anatomy)).toEqual(["lineage", "xRelation", "logo", "fee", "depth"]);
  });

  it("serves guests with no session and names no coin", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/tokensage" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totals: { reads: number } }>();
    expect(typeof body.totals.reads).toBe("number");
    for (const mint of MINTS) expect(res.body).not.toContain(mint);
  });
});
