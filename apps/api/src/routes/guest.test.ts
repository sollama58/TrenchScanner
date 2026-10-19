// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadEnv,
  loadTopModels,
  prisma,
  resetTopModelsCache,
  topModelsWindow,
  TOP_MODELS_RANK_MIN_GRADED,
  type ContestantSpec,
  type Env,
} from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { contestState, resetContestStateCache } from "../contest.js";
import { GUEST_DELAY_MINUTES, loadGuestBest, loadGuestRows } from "./guest.js";

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

  it("reads the market weather without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/weather" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { condition: string; recentHours: number; trailingDays: number };
    expect(["hot", "normal", "cold", "unknown"]).toContain(body.condition);
    expect(body.recentHours).toBeGreaterThan(0);
    expect(body.trailingDays).toBeGreaterThan(0);
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

  it("serves a 24h leaderboard with its own baseline, but no 24h insights fill", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/models?days=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { window: { days: number }; baseline: { graded: number } };
    expect(body.window.days).toBe(1);
    expect(typeof body.baseline.graded).toBe("number");
    expect((await app.inject({ method: "GET", url: "/guest/insights?days=1" })).statusCode).toBe(400);
  });

  it("serves the Models tab's reports without the AI reviewer's live calls", async () => {
    const res = await app.inject({ method: "GET", url: "/guest/insights?days=30" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { recentAiReviews: unknown[] }).recentAiReviews).toEqual([]);
    expect(res.body).not.toContain("secret reasoning");
  });

  it("serves one model's training runs, and 404s a model off the roster", async () => {
    const res = await app.inject({ method: "GET", url: `/guest/models/${defaultModel}/runs` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contestant: string; runs: { contestant: string }[] };
    expect(body.contestant).toBe(defaultModel);
    expect(body.runs.every((r) => r.contestant === defaultModel)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/guest/models/no-such-model/runs" })).statusCode).toBe(
      404,
    );
  });

  it("leaves the paid feeds gated", async () => {
    expect((await app.inject({ method: "GET", url: "/curated" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/matches" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/curated/models" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/curated/insights" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: `/curated/models/${defaultModel}/runs` })).statusCode,
    ).toBe(401);
  });
});

/**
 * The default feed as top models: the three best composite scores (with enough graded calls) are
 * picked, and a token several of them called is one guest card. Seeded under model ids no real
 * roster has, so the shared test database's real default never changes under other test files.
 */
describe.skipIf(!dbAvailable)("top-models default feed", () => {
  const TOP = `top-models-test-${Date.now()}`;
  const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };
  const ids = ["a", "b", "c", "d", "lucky"].map((k) => `${TOP}-${k}`);
  const [a, b, c, d, lucky] = ids as [string, string, string, string, string];
  const roster = ids.map((id) => ({ id, name: id, role: "learner" }) as unknown as ContestantSpec);
  let shared = "";

  beforeAll(async () => {
    const n = TOP_MODELS_RANK_MIN_GRADED;
    const token = async (k: string) =>
      (await prisma.token.create({ data: { mintAddress: `${TOP}-${k}` } })).id;
    shared = await token("shared");
    const solo = await token("solo");
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    // The ranked calls sit inside the current 6-hour slot's window, which ends before the slot starts.
    const windowEnd = topModelsWindow(new Date()).until.getTime();
    const beforeWindowEnd = (h: number) => new Date(windowEnd - h * 3_600_000);
    // a 50%, b 40%, c 30%, d 20%, all at the same return: a, b and c make the cut, a is "best".
    // lucky is 2 for 2 at +300%, under the floor.
    const graded = (model: string, wins: number, sim = -10) =>
      Array.from({ length: n }, (_, i) => ({
        ...base,
        tokenId: solo,
        model,
        hit2xIn1h: i < wins,
        simReturnPct: sim,
        createdAt: beforeWindowEnd(1 + i / 100),
      }));
    await prisma.curatedAlert.createMany({
      data: [
        ...graded(a, n * 0.5),
        ...graded(b, n * 0.4),
        ...graded(c, n * 0.3),
        ...graded(d, n * 0.2),
        {
          ...base,
          tokenId: solo,
          model: lucky,
          hit2xIn1h: true,
          simReturnPct: 300,
          createdAt: beforeWindowEnd(1),
        },
        {
          ...base,
          tokenId: solo,
          model: lucky,
          hit2xIn1h: true,
          simReturnPct: 300,
          createdAt: beforeWindowEnd(1),
        },
        // The newest calls: two top models on one token a minute apart, past the guest delay.
        { ...base, tokenId: shared, model: b, createdAt: hoursAgo(1) },
        { ...base, tokenId: shared, model: a, createdAt: new Date(hoursAgo(1).getTime() + 60_000) },
      ],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    resetTopModelsCache();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TOP } } });
    await prisma.topModelsPick.deleteMany({});
  });

  // Each slot's pick is stored and held; these cases re-pick within one slot, so start each afresh.
  const forgetPicks = async () => {
    resetTopModelsCache();
    await prisma.topModelsPick.deleteMany({});
  };

  it("picks the three best composite scores among models with enough graded calls", async () => {
    await forgetPicks();
    const picked = await loadTopModels(roster, [], () => true, targets);
    expect(picked).toMatchObject({ top: [a, b, c], best: a });
    expect(picked.last24h.get(a)).toEqual({
      graded: TOP_MODELS_RANK_MIN_GRADED,
      hitRate2xPct: 50,
      avgReturnPct: -10,
      qualifies: true,
    });
    expect(picked.last24h.get(lucky)).toMatchObject({ graded: 2, hitRate2xPct: 100, qualifies: false });
  });

  it("leaves out models that can't call, keeps a short pick, and gives up with none", async () => {
    await forgetPicks();
    expect((await loadTopModels(roster, [], (id) => id !== b, targets)).top).toEqual([a, c, d]);
    await forgetPicks();
    expect((await loadTopModels(roster, [], (id) => id === a || id === b, targets)).top).toEqual([a, b]);
    await forgetPicks();
    expect((await loadTopModels(roster, [], () => false, targets)).top).toBeNull();
  });

  it("gives a held model's place to the next-ranked one once it can't call", async () => {
    await forgetPicks();
    expect((await loadTopModels(roster, [], () => true, targets)).top).toEqual([a, b, c]);
    // Same slot, pick held: b stops calling, so d (next ranked) takes its place for the slot.
    expect((await loadTopModels(roster, [], (id) => id !== b, targets)).top).toEqual([a, c, d]);
    // b calls again: the held pick is served whole.
    expect((await loadTopModels(roster, [], () => true, targets)).top).toEqual([a, b, c]);
  });

  it("shows a token the top models both called as one card, at its first call", async () => {
    const rows = await loadGuestRows([a, b, c], 1);
    const card = rows.find((r) => r.alert.tokenId === shared)!;
    expect(rows[0]!.alert.tokenId).toBe(shared);
    expect(rows.filter((r) => r.alert.tokenId === shared)).toHaveLength(1);
    expect(card.alert.model).toBe(b);
    expect(card.calledBy.map((x) => x.model)).toEqual([b, a]);
  });
});

/** The signed-out page's showcase: the best passed call of the last 24 hours, by its Peak. */
describe.skipIf(!dbAvailable)("guest showcase", () => {
  const tag = `guest-best-test-${Date.now()}`;
  const shown = `${tag}-shown`;
  const other = `${tag}-other`;

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: tag } } });
  });

  it("picks the highest Peak among calls that passed, skipping stop-outs, other models and old calls", async () => {
    expect(await loadGuestBest([shown])).toBeNull();
    const token = async (key: string) =>
      (await prisma.token.create({ data: { mintAddress: `${tag}-${key}` } })).id;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const base = {
      source: "test",
      confidence: 70,
      anchorPriceUsd: 0.0001,
      anchorMcapUsd: 50_000,
      model: shown,
    };
    const won = { hit2xIn1h: true, disqualified: false };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, ...won, tokenId: await token("a"), createdAt: hoursAgo(3), peak24hReturnPct: 400 },
        { ...base, ...won, tokenId: await token("b"), createdAt: hoursAgo(5), peak24hReturnPct: 900 },
        // Stopped out after a bigger run: not a win to show off.
        {
          ...base,
          hit2xIn1h: true,
          disqualified: true,
          tokenId: await token("c"),
          createdAt: hoursAgo(2),
          peak24hReturnPct: 5_000,
        },
        // A miss.
        {
          ...base,
          hit2xIn1h: false,
          disqualified: false,
          tokenId: await token("d"),
          createdAt: hoursAgo(2),
          peak24hReturnPct: 80,
        },
        // Too old, and another model's.
        { ...base, ...won, tokenId: await token("e"), createdAt: hoursAgo(30), peak24hReturnPct: 9_000 },
        {
          ...base,
          ...won,
          model: other,
          tokenId: await token("f"),
          createdAt: hoursAgo(1),
          peak24hReturnPct: 9_000,
        },
      ],
    });
    const best = await loadGuestBest([shown]);
    expect(best?.token.mintAddress).toBe(`${tag}-b`);
    expect(best?.peakReturnPct).toBe(900);
  });

  it("steps down past a call now trading under its alert price", async () => {
    // b's coin now sits under its $50K alert: a (next by Peak) takes the showcase.
    await prisma.token.update({
      where: { mintAddress: `${tag}-b` },
      data: { liveMarketCapUsd: 40_000, liveDataAt: new Date() },
    });
    expect((await loadGuestBest([shown]))?.token.mintAddress).toBe(`${tag}-a`);
    // Every candidate under: the best one stays.
    await prisma.token.update({
      where: { mintAddress: `${tag}-a` },
      data: { liveMarketCapUsd: 30_000, liveDataAt: new Date() },
    });
    expect((await loadGuestBest([shown]))?.token.mintAddress).toBe(`${tag}-b`);
  });
});
