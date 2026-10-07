// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { buildFeatureFillReport } from "./statsModels.js";

const TOKEN = "stats-test-token-0123456789abcdef0123456789";

describe("GET /stats/models and /stats/features gating", () => {
  it("does not exist without a token, and rejects a wrong one", async () => {
    const off = await buildServer({ ...loadEnv(), STATS_API_TOKEN: "" });
    const on = await buildServer({ ...loadEnv(), STATS_API_TOKEN: TOKEN });
    try {
      for (const url of ["/stats/models", "/stats/features"]) {
        expect((await off.inject({ method: "GET", url })).statusCode).toBe(404);
        expect((await on.inject({ method: "GET", url })).statusCode).toBe(401);
        const bad = await on.inject({
          method: "GET",
          url: `${url}?days=99&hours=99`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(bad.statusCode).toBe(400);
      }
    } finally {
      await off.close();
      await on.close();
    }
  });
});

/** CI provisions Postgres; this skips rather than fails on a machine without a database. */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `stats-features-test-${Date.now()}`;
// A window nothing else in the database can fall into.
const BASE = new Date("2001-03-04T00:00:00Z");
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

describe.skipIf(!dbAvailable)("buildFeatureFillReport", () => {
  let tokenId: string;

  beforeAll(async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "FEAT" } });
    tokenId = token.id;
    const rows: { kind: string; features: Record<string, number | null> }[] = [
      { kind: "event", features: { uniqueBuyers5m: 12, devSoldShare: 0, mcapUsd: 40 } },
      { kind: "event", features: { uniqueBuyers5m: 30, devSoldShare: 0, mcapUsd: 60 } },
      { kind: "hourly", features: { uniqueBuyers5m: null, devSoldShare: 0, mcapUsd: 50 } },
      // Banked before the trade-flow inputs existed: the keys are missing entirely.
      { kind: "hourly", features: { mcapUsd: 70 } },
      // No features at all: jsonb_each yields nothing for it, but it is still a row of the window.
      { kind: "hourly", features: {} },
    ];
    for (const [i, r] of rows.entries()) {
      await prisma.candidateOutcome.create({
        data: {
          tokenId,
          anchorAt: at(i),
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          sampleKind: r.kind,
          features: r.features,
          nextCheckAt: at(i + 1),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
        },
      });
    }
  });

  afterAll(async () => {
    if (tokenId) {
      await prisma.candidateOutcome.deleteMany({ where: { tokenId } });
      await prisma.token.delete({ where: { id: tokenId } });
    }
  });

  it("reports each input's fill rate, zeros and range over the window's rows", async () => {
    const report = await buildFeatureFillReport(at(0), at(60));
    expect(report.rows).toBe(5);
    expect(report.rowsByKind).toEqual({ event: 2, hourly: 3 });
    const byName = new Map(report.features.map((f) => [f.feature, f]));
    expect(byName.get("uniqueBuyers5m")).toMatchObject({
      tradeFlow: true,
      presentPct: 40,
      zeroPct: 0,
      min: 12,
      max: 30,
      avg: 21,
    });
    // Present on three rows of five, but zero on all of them: as dead as a null input.
    expect(byName.get("devSoldShare")).toMatchObject({ presentPct: 60, zeroPct: 100 });
    // Four of five: the `{}` row counts against every input, not just the ones it would have had.
    expect(byName.get("mcapUsd")).toMatchObject({ tradeFlow: false, presentPct: 80 });
    expect(report.dead).toContain("devSoldShare");
    expect(report.dead).not.toContain("uniqueBuyers5m");
    expect(report.dead).not.toContain("mcapUsd");
  });
});

describe.skipIf(!dbAvailable)("GET /stats/models", () => {
  it("returns the default model, the ranking and the lift curve", async () => {
    const app = await buildServer({ ...loadEnv(), STATS_API_TOKEN: TOKEN });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/stats/models?days=2",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.window.days).toBe(2);
      expect(typeof body.defaultModel).toBe("string");
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.entries[0]).toHaveProperty("score");
      expect(Array.isArray(body.learning.days)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
