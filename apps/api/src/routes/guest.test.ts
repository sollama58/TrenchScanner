// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { contestState, resetContestStateCache } from "../contest.js";
import { GUEST_DELAY_MINUTES } from "./guest.js";

/**
 * GET /guest/feed: the default model's calls, 5 minutes late, for a visitor with no wallet - no session needed,
 * no other model's calls, no AI reviews, and only the first few pages.
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `guest-feed-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("guest feed", () => {
  const env: Env = dbAvailable ? loadEnv() : (undefined as never);
  let app: FastifyInstance;
  let defaultModel = "";
  let otherModel = "";
  const tokens: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };

  beforeAll(async () => {
    resetContestStateCache();
    const state = await contestState(env);
    defaultModel = state.defaultModel;
    otherModel = state.roster.find((c) => c.id !== defaultModel)!.id;
    for (const key of ["A", "B", "C"] as const) {
      tokens[key] = (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}` } })).id;
    }
    // Dated just past the guest delay so they sit on page 1 whatever else the database holds.
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    const alerts = await prisma.curatedAlert.createManyAndReturn({
      data: [
        { ...base, tokenId: tokens.A, model: defaultModel, createdAt: ago(GUEST_DELAY_MINUTES * 60 + 20) },
        { ...base, tokenId: tokens.B, model: otherModel, createdAt: ago(GUEST_DELAY_MINUTES * 60 + 10) },
        // Still inside the delay: guests don't see it yet.
        { ...base, tokenId: tokens.C, model: defaultModel, createdAt: ago(30) },
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

  it("answers without a session, with only the default model's calls past the delay", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/feed?page=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matches: { tokenId: string; curated: { model: string; aiReview?: unknown } }[];
      model: { id: string };
      delayMinutes: number;
    };
    expect(body.delayMinutes).toBe(GUEST_DELAY_MINUTES);
    expect(body.model.id).toBe(defaultModel);
    const mine = body.matches.filter((c) => Object.values(tokens).includes(c.tokenId));
    expect(mine.map((c) => c.tokenId)).toEqual([tokens.A]);
    expect(mine[0]!.curated.model).toBe(defaultModel);
    expect(mine[0]!.curated.aiReview).toBeUndefined();
    expect(res.body).not.toContain("secret reasoning");
  });

  it("only serves the first few pages", async () => {
    expect((await app.inject({ method: "GET", url: "/guest/feed?page=6" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/guest/feed?page=5" })).statusCode).toBe(200);
  });

  it("serves the Models tab's leaderboard with the default model as the guest's feed", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/models?days=30" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      selectedModel: defaultModel,
      selectedModels: [defaultModel],
      followsDefault: true,
      followBest: true,
    });
    expect((await app.inject({ method: "GET", url: "/guest/models?days=2" })).statusCode).toBe(400);
  });

  it("serves the Models tab's reports without the AI reviewer's live calls", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/insights?days=30" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { recentAiReviews: unknown[] }).recentAiReviews).toEqual([]);
    expect(res.body).not.toContain("secret reasoning");
  });

  it("leaves the paid feeds gated", async () => {
    expect((await app.inject({ method: "GET", url: "/curated" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/matches" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/curated/models" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/curated/insights" })).statusCode).toBe(401);
  });
});
