// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv, HEURISTIC_CURATOR_SOURCE, STACKED_MODEL_KIND } from "@trenchscanner/core";
import { buildLeaderboard, contestState, resetContestStateCache, resolveFeedModel } from "./contest.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `contest-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("curator contest API state", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);
  const modelIds: string[] = [];

  async function retireAll() {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    resetContestStateCache();
  }

  async function activeModel(contestant: string, kind: string, threshold: number, exam?: object) {
    const row = await prisma.curatorModel.create({
      data: {
        contestant,
        kind,
        params: { kind, threshold },
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: exam ? { exam } : {},
        status: "active",
        activatedAt: new Date(),
      },
    });
    modelIds.push(row.id);
    return row.id;
  }

  beforeAll(retireAll);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.curatorModel.deleteMany({ where: { id: { in: modelIds } } });
    resetContestStateCache();
  });

  it("defaults to Rules until a consensus that can call exists, then to the consensus", async () => {
    await retireAll();
    expect((await contestState(env)).defaultModel).toBe("rules");

    await activeModel("consensus", STACKED_MODEL_KIND, 1.01);
    resetContestStateCache();
    expect((await contestState(env)).defaultModel).toBe("rules");

    await retireAll();
    await activeModel("consensus", STACKED_MODEL_KIND, 0.4);
    resetContestStateCache();
    expect((await contestState(env)).defaultModel).toBe("consensus");
  });

  it("resolves a feed request: explicit pick, then the saved pick, then the default", async () => {
    const state = await contestState(env);
    expect(resolveFeedModel(state, "trees", "linear")).toBe("trees");
    expect(resolveFeedModel(state, undefined, "linear")).toBe("linear");
    expect(resolveFeedModel(state, "not-a-model", null)).toBe(state.defaultModel);
    expect(resolveFeedModel(state, undefined, "retired-model")).toBe(state.defaultModel);
  });

  it("ranks the leaderboard on composite scores built from live calls and exams", async () => {
    await retireAll();
    await activeModel("consensus", STACKED_MODEL_KIND, 0.4, {
      calls: 60,
      graded: 60,
      wins: 50,
      goals: 35,
      sumLabel: 110,
    });
    await activeModel("linear", "weighted-logistic-v1", 1.01, {
      calls: 0,
      graded: 0,
      wins: 0,
      goals: 0,
      sumLabel: 0,
    });
    resetContestStateCache();

    // Two graded live Rules calls: one clean 4x (label from its training row), one stopped out.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-live` } });
    const outcome = await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
        features: {},
        nextCheckAt: new Date(),
        peak1hPriceUsd: 4,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 4,
        finalizedAt: new Date(),
        hit2xIn1h: true,
        hit4xIn1h: true,
        disqualified: false,
        labelValue: 2,
      },
    });
    const base = {
      tokenId: token.id,
      model: "rules",
      source: HEURISTIC_CURATOR_SOURCE,
      confidence: 90,
      anchorPriceUsd: 1,
      anchorMcapUsd: 100_000,
    };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, candidateOutcomeId: outcome.id },
        // Training row pruned: graded from the copies, its return from the copied 1h peak.
        { ...base, hit2xIn1h: true, hit4xIn1h: false, disqualified: true, peak1hReturnPct: 150 },
        // Still in its window.
        { ...base },
      ],
    });

    const board = await buildLeaderboard(env, 30);
    const byId = new Map(board.entries.map((e) => [e.id, e]));
    expect(board.defaultModel).toBe("consensus");
    expect(byId.get("consensus")).toMatchObject({ rank: 1, isDefault: true, status: "calling" });
    expect(byId.get("linear")?.status).toBe("silent");
    expect(byId.get("trees")?.status).toBe("untrained");
    const rules = byId.get("rules")!;
    expect(rules.composite.live).toMatchObject({ calls: 3, graded: 2, winRatePct: 50, goalRatePct: 50 });
    expect(rules.composite.live.avgReturnDoublings).toBe(1);
    expect(board.entries.map((e) => e.rank)).toEqual(board.entries.map((_, i) => i + 1));
  });
});
