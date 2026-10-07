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
  await prisma.candidateOutcome.deleteMany({ where: { token: { mintAddress: { in: MINTS } } } });
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
            { label: "lhanimal/dog", confidence: 0.9 },
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
          categories: [{ label: "lhanimal/dog", confidence: 0.7 }],
          referentKind: "animal",
          copiesRecent: false,
        },
        {
          mintAddress: MINT_AI,
          depth: "basic",
          status: "partial",
          // A malformed confidence must not break the query.
          categories: [{ label: "lhtech/ai", confidence: "high" }],
          referentConfidence: 0.5,
        },
        { mintAddress: MINT_BAD, depth: "basic", status: "failed", failReason: "not_pumpfun: secret reason" },
      ],
    });
    // Decision moments for screened tokens: one clean 4x, one 2x after the stop (a loss), one
    // dud, one still open; and an hourly row, which isn't a decision moment.
    const at = new Date(Date.now() - 2 * 3_600_000);
    const row = {
      anchorAt: at,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      features: {},
      nextCheckAt: at,
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
      sampleKind: "event",
    };
    await prisma.candidateOutcome.createMany({
      data: [
        {
          ...row,
          tokenId: tokens[0]!.id,
          hit2xIn1h: true,
          hit4xIn1h: true,
          hit10xIn1h: false,
          simReturnPct: 150,
        },
        {
          ...row,
          tokenId: tokens[1]!.id,
          hit2xIn1h: true,
          disqualified: true,
          hit4xIn1h: false,
          simReturnPct: -50,
        },
        { ...row, tokenId: tokens[2]!.id, hit2xIn1h: false, hit4xIn1h: false, simReturnPct: -20 },
        { ...row, tokenId: tokens[3]!.id },
        { ...row, tokenId: tokens[3]!.id, sampleKind: "hourly", hit2xIn1h: true, simReturnPct: 900 },
      ],
    });
    const base = { source: TAG, confidence: 80, anchorPriceUsd: 1, anchorMcapUsd: 50_000 };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, tokenId: tokens[0]!.id, hit2xIn1h: true, hit4xIn1h: false, simReturnPct: 40 },
        { ...base, tokenId: tokens[1]!.id, hit2xIn1h: false, hit4xIn1h: false, simReturnPct: -50 },
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
    // Other suites share the database, so this test's rows are checked as a floor, and its
    // narratives carry labels no other suite uses.
    expect(d.reads.total).toBeGreaterThanOrEqual(4);
    expect(d.reads.failed).toBeGreaterThanOrEqual(1);
    expect(d.reads.deep).toBeGreaterThanOrEqual(1);
    expect(d.reads.described).toBe(d.reads.total - d.reads.failed);
    // A read with no referent is counted, never shown as a "(none)" kind.
    expect(d.reads.noReferent).toBeGreaterThanOrEqual(1);
    expect(d.referentKinds.map((k) => k.label)).not.toContain("(none)");
    expect(d.referentKinds.find((k) => k.label === "animal")?.count).toBeGreaterThanOrEqual(1);
    expect(d.window.bucketHours).toBe(1);
    expect(d.tide.buckets.length).toBeGreaterThanOrEqual(24);
    const sum = (label: string) =>
      d.tide.series.find((s) => s.label === label)?.values.reduce((a, b) => a + b, 0);
    expect(sum("lhanimal")).toBe(2);
    expect(sum("lhtech")).toBe(1);
    expect(d.categories.find((c) => c.label === "lhanimal/dog")?.count).toBe(2);
    expect(d.xVerdicts.find((v) => v.label === "about_this_coin")?.count).toBeGreaterThanOrEqual(1);
    expect(d.copies.map((c) => c.label)).toEqual(
      expect.arrayContaining(["copies a recent coin", "original"]),
    );
    expect(d.news.find((n) => n.label === "in the news")?.count).toBeGreaterThanOrEqual(1);
    const animalCalls = d.outcomes.byCategory.find((t) => t.label === "lhanimal");
    expect(animalCalls).toMatchObject({
      alerts: 2,
      graded: 2,
      won2x: 1,
      won10x: 0,
      returnN: 2,
      returnSum: -10,
    });
  });

  it("grades every screened decision moment and says what the pre-checks are", async () => {
    const d = (await app.inject({ method: "GET", url: "/guest/lighthouse?days=1" })).json<MarketLighthouse>();
    const s = d.screened;
    // Other suites may bank event rows too, so check this test's rows are counted, not exact totals.
    expect(s.graded).toBeGreaterThanOrEqual(3);
    expect(s.bucketHours).toBe(3);
    expect(s.checks).toMatchObject({ freshWalletMaxPct: 70, emptyWalletRejectPct: 80 });
    expect(s.exitPlan).toMatch(/2x/);
    const mine = await prisma.candidateOutcome.findMany({
      where: { token: { mintAddress: { in: MINTS } }, sampleKind: "event" },
    });
    expect(mine).toHaveLength(4);
    const bucket = s.byBucket.find((b) => b.graded >= 3);
    expect(bucket).toBeDefined();
    expect(s.hit2xPct).not.toBeNull();
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
