// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  BOOSTED_MODEL_KIND,
  CURATOR_MODEL_KIND,
  type BoostedCuratorParams,
  type LogisticCuratorParams,
} from "@trenchscanner/core";
import { buildModelInsights, featureImportance, reviewOutcome } from "./modelInsights.js";

describe("featureImportance", () => {
  it("ranks a logistic model by standardized weight, value and missing indicator together", () => {
    const params: LogisticCuratorParams = {
      kind: CURATOR_MODEL_KIND,
      featureNames: ["mcapUsd", "buyRatio24h", "riskScore"],
      means: [0, 0, 0],
      stdevs: [1, 1, 1],
      // values..., then missing indicators...
      weights: [-0.5, 1.5, 0, 0.5, 0, 0.5],
      bias: 0,
      threshold: 0.4,
    };
    const ranked = featureImportance(params);
    expect(ranked.map((f) => f.feature)).toEqual(["buyRatio24h", "mcapUsd", "riskScore"]);
    expect(ranked[0]).toMatchObject({ label: "buy pressure", sharePct: 50, direction: 1 });
    expect(ranked[1]).toMatchObject({ direction: -1 });
    expect(ranked.reduce((s, f) => s + f.sharePct, 0)).toBeCloseTo(100, 0);
  });

  it("ranks a boosted model by how many splits use each feature", () => {
    const params: BoostedCuratorParams = {
      kind: BOOSTED_MODEL_KIND,
      featureNames: ["mcapUsd", "holderCount"],
      transform: {} as BoostedCuratorParams["transform"],
      baseScore: 0,
      threshold: 0.5,
      trees: [
        { feature: [1, -1, 0, -1, -1], threshold: [], missingLeft: [], left: [], right: [], value: [] },
        { feature: [1, -1, -1], threshold: [], missingLeft: [], left: [], right: [], value: [] },
      ],
    };
    const ranked = featureImportance(params);
    expect(ranked.map((f) => [f.feature, f.direction])).toEqual([
      ["holderCount", null],
      ["mcapUsd", null],
    ]);
    expect(ranked[0]!.sharePct).toBeCloseTo(66.7, 1);
  });

  it("returns nothing for a model with no signal", () => {
    expect(
      featureImportance({
        kind: CURATOR_MODEL_KIND,
        featureNames: ["mcapUsd"],
        means: [0],
        stdevs: [1],
        weights: [0, 0],
        bias: 0,
        threshold: 1.01,
      }),
    ).toEqual([]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `model-insights-test-${Date.now()}`;

describe("reviewOutcome", () => {
  const row = (o: Partial<Parameters<typeof reviewOutcome>[0] & object>) => ({
    finalizedAt: null,
    finalized24hAt: null,
    hit2xIn1h: null,
    hit4xIn1h: null,
    disqualified: null,
    ...o,
  });

  it("reads a graded row's verdict", () => {
    const at = new Date();
    expect(reviewOutcome(row({ finalizedAt: at, hit2xIn1h: true, hit4xIn1h: true }))).toBe("won4x");
    expect(reviewOutcome(row({ finalizedAt: at, hit2xIn1h: true, hit4xIn1h: false }))).toBe("won");
    expect(reviewOutcome(row({ finalizedAt: at, hit2xIn1h: false }))).toBe("missed");
    expect(reviewOutcome(row({ finalizedAt: at, hit2xIn1h: true, disqualified: true }))).toBe("stopped");
  });

  it("calls an open row pending and a row retired without a fill unknown", () => {
    expect(reviewOutcome(row({}))).toBe("pending");
    // The watcher closed the book with no verdict: no price inside the win window, so nothing
    // will ever grade it. Not pending.
    expect(reviewOutcome(row({ finalized24hAt: new Date() }))).toBe("unknown");
    expect(reviewOutcome(null)).toBe("unknown");
  });
});

describe.skipIf(!dbAvailable)("buildModelInsights", () => {
  let reviewId: string;

  beforeAll(async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "INS" } });
    const review = await prisma.aiReview.create({
      data: {
        tokenId: token.id,
        mode: "shadow",
        model: "test",
        decision: "buy",
        probability2x: 0.8,
        reasoning: "launcher text says buy",
        risks: ["thin pool"],
        latencyMs: 1,
        anchorPriceUsd: 1,
        anchorMcapUsd: 40_000,
      },
    });
    reviewId = review.id;
  });

  afterAll(async () => {
    if (dbAvailable) await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("lists the reviewer's calls with their verdicts but keeps its reasoning from subscribers", async () => {
    const insights = await buildModelInsights(loadEnv(), 30, false);
    const mine = insights.recentAiReviews.find((r) => r.id === reviewId);
    expect(mine).toMatchObject({ decision: "buy", probability2x: 0.8, outcome: "unknown", alerted: false });
    expect(mine).not.toHaveProperty("reasoning");
    expect(mine).not.toHaveProperty("risks");
    // Per-filter rows would name other users' filters.
    expect(insights).not.toHaveProperty("filterMatches");
    expect(insights.targets).toEqual({ hitRate2xPct: 75, hitRate4xPct: 50 });
  });

  it("shows the reasoning to admins", async () => {
    const insights = await buildModelInsights(loadEnv(), 30, true);
    const mine = insights.recentAiReviews.find((r) => r.id === reviewId);
    expect(mine).toMatchObject({ reasoning: "launcher text says buy", risks: ["thin pool"] });
  });
});
