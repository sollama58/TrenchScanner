// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { MarketLighthouse } from "../marketLighthouse.js";

/**
 * GET /guest/lighthouse and /curated/lighthouse: TokenSage's reads in aggregate for the Models
 * tab. Open to guests, so it must never name a coin: no mint, symbol, referent or summary.
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = "lighthouse-test";
const MINT_DOG = "LightDog111111111111111111111111111111111111";
const MINT_DOG2 = "LightDog211111111111111111111111111111111111";
const MINT_AI = "LightAi1111111111111111111111111111111111111";
const MINT_BAD = "LightBad111111111111111111111111111111111111";
const MINTS = [MINT_DOG, MINT_DOG2, MINT_AI, MINT_BAD];

async function cleanup() {
  await prisma.curatedAlert.deleteMany({ where: { source: TAG } });
  await prisma.token.deleteMany({ where: { mintAddress: { in: MINTS } } });
  await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { in: MINTS } } });
}

describe.skipIf(!dbAvailable)("market lighthouse", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await cleanup();
    const env: Env = loadEnv();
    app = await buildServer(env);
    const tokens = await Promise.all(
      MINTS.map((mintAddress) =>
        prisma.token.create({ data: { mintAddress, symbol: `SECRET${mintAddress.slice(5, 8)}` } }),
      ),
    );
    await prisma.tokenNarrative.createMany({
      data: [
        {
          mintAddress: MINT_DOG,
          depth: "full",
          status: "complete",
          categories: [
            { label: "meme", confidence: 0.4 },
            { label: "animal/dog", confidence: 0.9 },
          ],
          referentLabel: "Secret Referent",
          referentKind: "animal",
          referentSupport: ["name", "x"],
          summary: "secret summary",
          flags: ["copycat"],
          xVerdict: "about_this_coin",
          xFit: 0.8,
          copiesRecent: true,
          trendMatched: true,
        },
        {
          mintAddress: MINT_DOG2,
          depth: "basic",
          status: "complete",
          categories: [{ label: "animal/dog", confidence: 0.7 }],
          referentKind: "animal",
          copiesRecent: false,
        },
        {
          mintAddress: MINT_AI,
          depth: "basic",
          status: "partial",
          // A malformed confidence must not break the query.
          categories: [{ label: "tech/ai", confidence: "high" }],
          referentConfidence: 0.5,
        },
        { mintAddress: MINT_BAD, depth: "basic", status: "failed", failReason: "not_pumpfun: secret reason" },
      ],
    });
    const base = { source: TAG, confidence: 80, anchorPriceUsd: 1, anchorMcapUsd: 50_000 };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, tokenId: tokens[0]!.id, hit2xIn1h: true, hit4xIn1h: false },
        { ...base, tokenId: tokens[1]!.id, hit2xIn1h: false, hit4xIn1h: false },
        { ...base, tokenId: tokens[2]!.id },
      ],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await cleanup();
  });

  it("serves guests aggregates that name no coin", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/lighthouse?days=1" });
    expect(res.statusCode).toBe(200);
    for (const secret of [...MINTS, "SECRET", "Secret Referent", "secret summary", "secret reason"]) {
      expect(res.body).not.toContain(secret);
    }
    const d = res.json<MarketLighthouse>();
    expect(d.reads).toMatchObject({ total: 4, described: 3, deep: 1, quick: 2, failed: 1 });
    expect(d.window.bucketHours).toBe(1);
    expect(d.tide.buckets.length).toBeGreaterThanOrEqual(24);
    const animal = d.tide.series.find((s) => s.label === "animal");
    const tech = d.tide.series.find((s) => s.label === "tech");
    expect(animal?.values.reduce((a, b) => a + b, 0)).toBe(2);
    expect(tech?.values.reduce((a, b) => a + b, 0)).toBe(1);
    expect(d.tide.series[0]!.label).toBe("animal");
    expect(d.categories.find((c) => c.label === "animal/dog")?.count).toBe(2);
    expect(d.xVerdicts).toEqual([{ label: "about_this_coin", count: 1 }]);
    expect(d.copies).toEqual(
      expect.arrayContaining([
        { label: "copies a recent coin", count: 1 },
        { label: "original", count: 1 },
      ]),
    );
    expect(d.news).toEqual([{ label: "in the news", count: 1 }]);
    const animalCalls = d.outcomes.byCategory.find((t) => t.label === "animal");
    expect(animalCalls).toMatchObject({ alerts: 2, graded: 2, won2x: 1 });
  });

  it("serves the 7-day window and rejects others", async () => {
    const week = await app.inject({ method: "GET", url: "/guest/lighthouse?days=7" });
    expect(week.statusCode).toBe(200);
    expect(week.json<MarketLighthouse>().window.bucketHours).toBe(6);
    expect((await app.inject({ method: "GET", url: "/guest/lighthouse?days=2" })).statusCode).toBe(400);
  });

  it("keeps the subscriber route behind access", async () => {
    expect((await app.inject({ method: "GET", url: "/curated/lighthouse" })).statusCode).toBe(401);
  });
});
