// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv, HEURISTIC_CURATOR_SOURCE } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { bearerMatches, withRates } from "./stats.js";

const TOKEN = "stats-test-token-0123456789abcdef0123456789";
const TARGETS = { hitRate2xPct: 75, hitRate4xPct: 50 };

describe("bearerMatches", () => {
  it("accepts only the exact token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}`, "")).toBe(false);
  });
});

describe("withRates", () => {
  const counts = { calls: 50, graded: 40, won2x: 32, won4x: 20, doubledAfterStop: 3 };

  it("computes rates over graded calls only", () => {
    const r = withRates(counts, TARGETS);
    expect(r.pending).toBe(10);
    expect(r.hitRate2xPct).toBe(80);
    expect(r.hitRate4xPct).toBe(50);
    expect(r.verdict).toBe("meets-targets");
  });

  it("misses the targets when either rate falls short", () => {
    expect(withRates({ ...counts, won4x: 19 }, TARGETS).verdict).toBe("below-targets");
    expect(withRates({ ...counts, won2x: 29 }, TARGETS).verdict).toBe("below-targets");
  });

  it("withholds a verdict on a small sample", () => {
    expect(withRates({ ...counts, graded: 29 }, TARGETS).verdict).toBe("insufficient-data");
    expect(
      withRates({ calls: 0, graded: 0, won2x: 0, won4x: 0, doubledAfterStop: 0 }, TARGETS),
    ).toMatchObject({
      hitRate2xPct: null,
      verdict: "insufficient-data",
    });
  });
});

describe("GET /stats/hit-rates gating", () => {
  it("does not exist without a token, or with one too short to trust", async () => {
    for (const STATS_API_TOKEN of ["", "short-token"]) {
      const app = await buildServer({ ...loadEnv(), STATS_API_TOKEN });
      try {
        const res = await app.inject({ method: "GET", url: "/stats/hit-rates" });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }
  });

  it("rejects a missing or wrong token", async () => {
    const app = await buildServer({ ...loadEnv(), STATS_API_TOKEN: TOKEN });
    try {
      expect((await app.inject({ method: "GET", url: "/stats/hit-rates" })).statusCode).toBe(401);
      const wrong = await app.inject({
        method: "GET",
        url: "/stats/hit-rates",
        headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/** CI provisions Postgres; this skips rather than fails on a machine without a database. */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `stats-test-${Date.now()}`;
// A window nothing else in the database can fall into, so the counts are exactly the fixture's.
const BASE = new Date("2001-02-03T00:00:00Z");
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

describe.skipIf(!dbAvailable)("GET /stats/hit-rates report", () => {
  let app: FastifyInstance;
  let tokenId: string;
  let userId: string;

  /** One graded (or pending) anchor row. */
  async function outcome(
    minute: number,
    kind: string,
    verdict: { hit2x: boolean; hit4x?: boolean; dq?: boolean } | null,
  ): Promise<string> {
    const row = await prisma.candidateOutcome.create({
      data: {
        tokenId,
        anchorAt: at(minute),
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
        sampleKind: kind,
        features: {},
        nextCheckAt: at(minute + 1),
        peak1hPriceUsd: 1,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 1,
        ...(verdict && {
          finalizedAt: at(minute + 60),
          hit2xIn1h: verdict.hit2x,
          hit4xIn1h: verdict.hit4x ?? false,
          disqualified: verdict.dq ?? false,
        }),
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await buildServer({ ...loadEnv(), STATS_API_TOKEN: TOKEN });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "STAT" } });
    tokenId = token.id;

    // Curated: a 4x win, a plain 2x, a stop-then-double (a loss), and one still in its hour.
    // The first carries its outcome copies; the rest are read through the live link.
    const live = [
      await outcome(1, "emission", { hit2x: true, hit4x: true }),
      await outcome(2, "emission", { hit2x: true }),
      await outcome(3, "emission", { hit2x: true, dq: true }),
      await outcome(4, "emission", null),
    ];
    for (const [i, candidateOutcomeId] of live.entries()) {
      await prisma.curatedAlert.create({
        data: {
          tokenId,
          candidateOutcomeId,
          createdAt: at(i + 1),
          source: HEURISTIC_CURATOR_SOURCE,
          confidence: 85,
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          ...(i === 0 && { hit2xIn1h: true, hit4xIn1h: true, disqualified: false }),
        },
      });
    }

    // Shadow: the bench model, one win and one loss.
    for (const [i, verdict] of [{ hit2x: true }, { hit2x: false }].entries()) {
      await prisma.curatedShadowEmission.create({
        data: {
          tokenId,
          candidateOutcomeId: await outcome(10 + i, "emission", verdict),
          createdAt: at(10 + i),
          source: "model-abc",
          confidence: 42,
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
        },
      });
    }

    // AI reviewer: a right buy, a wrong buy, a right veto, and a failed call.
    const reviews = [
      { decision: "buy", p: 0.82, verdict: { hit2x: true } },
      { decision: "buy", p: 0.71, verdict: { hit2x: false } },
      { decision: "no_buy", p: 0.2, verdict: { hit2x: false } },
      { decision: null, p: null, verdict: null },
    ];
    for (const [i, r] of reviews.entries()) {
      await prisma.aiReview.create({
        data: {
          tokenId,
          candidateOutcomeId: r.verdict ? await outcome(20 + i, "event", r.verdict) : null,
          createdAt: at(20 + i),
          mode: "shadow",
          model: "test",
          decision: r.decision,
          probability2x: r.p,
          error: r.decision ? null : "timeout",
          latencyMs: 1,
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
        },
      });
    }

    // Filter matches: one win, one loss.
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    const filter = await prisma.userFilter.create({ data: { userId, name: `${TAG}-filter` } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId, priceUsd: 1, marketCapUsd: 50_000, score: 60, takenAt: at(30) },
    });
    for (const [i, won] of [true, false].entries()) {
      await prisma.match.create({
        data: {
          userId,
          filterId: filter.id,
          tokenId,
          snapshotId: snapshot.id,
          matchedAt: at(30 + i),
          score: 60,
          hit2xIn1h: won,
          hit4xIn1h: false,
          disqualified: false,
        },
      });
    }
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (tokenId) await prisma.token.delete({ where: { id: tokenId } });
    await app?.close();
  });

  it("grades every kind of call under the current rules", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/stats/hit-rates?since=${at(0).toISOString()}&until=${at(120).toISOString()}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();

    expect(body.curatedAlerts.total).toMatchObject({
      calls: 4,
      graded: 3,
      pending: 1,
      won2x: 2,
      won4x: 1,
      doubledAfterStop: 1,
      hitRate2xPct: 66.7,
      verdict: "insufficient-data",
    });
    expect(body.curatedAlerts.bySource).toEqual([
      expect.objectContaining({ source: HEURISTIC_CURATOR_SOURCE }),
    ]);

    expect(body.shadowEmissions.bySource).toEqual([
      expect.objectContaining({ source: "model-abc", calls: 2, graded: 2, won2x: 1, hitRate2xPct: 50 }),
    ]);

    expect(body.curatorConfidenceBands).toEqual([
      expect.objectContaining({ side: "heuristic", band: 80, calls: 4 }),
      expect.objectContaining({ side: "model", band: 40, calls: 2 }),
    ]);

    expect(body.aiReviewer.buys).toMatchObject({ calls: 2, graded: 2, won2x: 1, hitRate2xPct: 50 });
    expect(body.aiReviewer.allReviewed).toMatchObject({ calls: 3, graded: 3, won2x: 1 });
    expect(body.aiReviewer.byDecision).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: "error", calls: 1, graded: 0 }),
        expect.objectContaining({ decision: "no_buy", calls: 1, won2x: 0 }),
      ]),
    );
    expect(body.aiReviewer.probability2xBands.map((b: { band: number }) => b.band)).toEqual([20, 70, 80]);

    expect(body.filterMatches.total).toMatchObject({ calls: 2, graded: 2, won2x: 1 });
    expect(body.filterMatches.byFilter).toEqual([
      expect.objectContaining({ name: `${TAG}-filter`, calls: 2 }),
    ]);

    expect(body.samples.byKind).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "emission", calls: 6 }),
        expect.objectContaining({ kind: "event", calls: 3 }),
      ]),
    );
  });

  it("rejects a reversed window", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/stats/hit-rates?since=${at(10).toISOString()}&until=${at(0).toISOString()}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
