// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEURISTIC_CURATOR_SOURCE, loadEnv, prisma } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `curated-stats-test-${Date.now()}`;

/**
 * /curated/stats folds its counts into a few grouped SQL passes. This holds them to the plain
 * Prisma counts they replaced, on whatever the database holds plus a fixture of both curators'
 * live and shadow picks.
 */
describe.skipIf(!dbAvailable)("GET /curated/stats", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-wallet`, addedBy: TAG } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint` } });
    const base = { tokenId: token.id, confidence: 0.5, anchorPriceUsd: 1, anchorMcapUsd: 10_000 };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, source: HEURISTIC_CURATOR_SOURCE, model: "rules", hit2xIn1h: true, disqualified: false },
        { ...base, source: HEURISTIC_CURATOR_SOURCE, model: "rules", hit2xIn1h: false, hit4xIn1h: false },
        {
          ...base,
          source: "some-model",
          model: "rules",
          hit2xIn1h: true,
          disqualified: true,
          hit4xIn1h: true,
        },
        { ...base, source: "some-model", model: "other", peak24hReturnPct: 50 },
      ],
    });
    const outcome = await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        sampleKind: "event",
        anchorAt: new Date(),
        anchorPriceUsd: 1,
        anchorMcapUsd: 10_000,
        features: {},
        nextCheckAt: new Date(),
        peak1hPriceUsd: 2,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 2,
        finalizedAt: new Date(),
        labelValue: 1,
      },
    });
    await prisma.curatedShadowEmission.createMany({
      data: [
        { tokenId: token.id, source: "some-model", confidence: 0.4, anchorPriceUsd: 1, anchorMcapUsd: 1 },
        {
          tokenId: token.id,
          source: HEURISTIC_CURATOR_SOURCE,
          confidence: 0.4,
          anchorPriceUsd: 1,
          anchorMcapUsd: 1,
          candidateOutcomeId: outcome.id,
        },
      ],
    });
    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: user.id,
      walletAddress: user.walletAddress,
    });
  });

  afterAll(async () => {
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await prisma.token.deleteMany({ where: { mintAddress: `${TAG}-mint` } });
    await prisma.user.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await app?.close();
  });

  it("agrees with the per-count queries it replaced", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/curated/stats",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const model = body.curator.active as string;

    const day30 = new Date(Date.now() - 30 * 86_400_000);
    const expectRecord = async (side: "heuristic" | "model") => {
      const source =
        side === "heuristic" ? { equals: HEURISTIC_CURATOR_SOURCE } : { not: HEURISTIC_CURATOR_SOURCE };
      const since = { gte: day30 };
      const emitted =
        (await prisma.curatedAlert.count({ where: { source, createdAt: since } })) +
        (await prisma.curatedShadowEmission.count({ where: { source, createdAt: since } }));
      const graded =
        (await prisma.curatedAlert.count({ where: { source, createdAt: since, hit2xIn1h: { not: null } } })) +
        (await prisma.curatedShadowEmission.count({
          where: { source, createdAt: since, candidateOutcome: { finalizedAt: { not: null } } },
        }));
      const wins =
        (await prisma.curatedAlert.count({
          where: { source, createdAt: since, hit2xIn1h: true, disqualified: false },
        })) +
        (await prisma.curatedShadowEmission.count({
          where: { source, createdAt: since, candidateOutcome: { labelValue: { gt: 0 } } },
        }));
      return { emitted, graded, wins, hitRatePct: graded > 0 ? (wins / graded) * 100 : null };
    };
    expect(body.comparison30d.heuristic).toEqual(await expectRecord("heuristic"));
    expect(body.comparison30d.model).toEqual(await expectRecord("model"));

    const graded = await prisma.curatedAlert.count({ where: { model, hit2xIn1h: { not: null } } });
    expect(body.feed).toMatchObject({
      alertsTotal: await prisma.curatedAlert.count({ where: { model } }),
      graded,
      wins: await prisma.curatedAlert.count({ where: { model, hit2xIn1h: true, disqualified: false } }),
      goalHits: await prisma.curatedAlert.count({ where: { model, hit4xIn1h: true, disqualified: false } }),
      bestPeak24hReturnPct: (
        await prisma.curatedAlert.aggregate({ where: { model }, _max: { peak24hReturnPct: true } })
      )._max.peak24hReturnPct,
    });
    expect(body.comparison30d.heuristic.emitted).toBeGreaterThanOrEqual(3);
  });

  it("serves the Model tab's windows only, so ?days= can't be walked to force cache misses", async () => {
    const get = (url: string) =>
      app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
    for (const url of ["/curated/insights?days=13", "/curated/models?days=45", "/curated/models?days=1"]) {
      expect((await get(url)).statusCode).toBe(400);
    }
    const board = await get("/curated/models?days=7");
    expect(board.statusCode).toBe(200);
    expect(board.json().window.days).toBe(7);
    expect((await get("/curated/models")).json().window.days).toBe(30);
  });
});
