// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { contestState, resetContestStateCache } from "../contest.js";

/**
 * GET /guest/feed: the default model's calls for a visitor with no wallet - no session needed,
 * no other model's calls, no AI reviews, and only the first few pages.
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `guest-feed-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("guest feed", () => {
  const env: Env = dbAvailable ? loadEnv() : (undefined as never);
  let app: FastifyInstance;
  let defaultModel = "";
  let otherModel = "";
  const tokens: Record<"A" | "B", string> = { A: "", B: "" };

  beforeAll(async () => {
    resetContestStateCache();
    const state = await contestState(env);
    defaultModel = state.defaultModel;
    otherModel = state.roster.find((c) => c.id !== defaultModel)!.id;
    for (const key of ["A", "B"] as const) {
      tokens[key] = (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}` } })).id;
    }
    // Dated just ahead of now so they sit on page 1 whatever else the database holds.
    const soon = (minutes: number) => new Date(Date.now() + 60_000 + minutes * 60_000);
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    const alerts = await prisma.curatedAlert.createManyAndReturn({
      data: [
        { ...base, tokenId: tokens.A, model: defaultModel, createdAt: soon(0) },
        { ...base, tokenId: tokens.B, model: otherModel, createdAt: soon(5) },
      ],
    });
    await prisma.aiReview.create({
      data: {
        curatedAlertId: alerts[0]!.id,
        tokenId: tokens.A,
        mode: "shadow",
        decision: "buy",
        reasoning: "secret reasoning",
        model: "test",
        latencyMs: 1,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
      },
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("answers without a session, with only the default model's calls", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/feed?page=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matches: { tokenId: string; curated: { model: string; aiReview?: unknown } }[];
      model: { id: string };
    };
    expect(body.model.id).toBe(defaultModel);
    const mine = body.matches.filter((c) => c.tokenId === tokens.A || c.tokenId === tokens.B);
    expect(mine.map((c) => c.tokenId)).toEqual([tokens.A]);
    expect(mine[0]!.curated.model).toBe(defaultModel);
    expect(mine[0]!.curated.aiReview).toBeUndefined();
    expect(res.body).not.toContain("secret reasoning");
  });

  it("only serves the first few pages", async () => {
    expect((await app.inject({ method: "GET", url: "/guest/feed?page=6" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/guest/feed?page=5" })).statusCode).toBe(200);
  });

  it("leaves the paid feeds gated", async () => {
    expect((await app.inject({ method: "GET", url: "/curated" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/matches" })).statusCode).toBe(401);
  });
});
