// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, type Env, type ScoredToken } from "@trenchscanner/core";
import {
  collectCuratedContender,
  emitCuratedCycle,
  newCuratedCycle,
  resetCuratorModelCache,
} from "./curatedAlerts.js";
import { recordCandidateSample } from "./candidateOutcomeJob.js";
import type { AiReviewResult } from "../ai/reviewer.js";
import { resetAiBlendCache } from "../ai/blend.js";

const reviewPick = vi.fn<() => Promise<AiReviewResult>>();
/** Whether the reviewer has earned gate mode - true unless a test says otherwise. */
const gateQualified = vi.fn(async () => true);
vi.mock("../ai/reviewer.js", () => ({
  aiReviewEnabled: (env: Env) => env.AI_REVIEW_MODE !== "off" && env.ANTHROPIC_API_KEY !== "",
  aiGateQualified: () => gateQualified(),
  reviewPick: () => reviewPick(),
}));

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ai-review-test-${Date.now()}`;

function fixture(mintAddress: string): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    holderGrowthPct: 15,
    top10HolderPct: 20,
    ageMinutes: 90,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 95 },
  };
}

const verdict = (decision: "buy" | "no_buy"): AiReviewResult => ({
  verdict: {
    decision,
    probability2x: 0.4,
    probability4x: 0.2,
    reasoning: `said ${decision}`,
    risks: ["thin"],
  },
  error: null,
  model: "claude-opus-5-5",
  latencyMs: 1200,
  inputTokens: 900,
  outputTokens: 300,
});

describe.skipIf(!dbAvailable)("AI reviewer at the emission site", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const gate: Env = dbAvailable ? { ...base, AI_REVIEW_MODE: "gate", ANTHROPIC_API_KEY: "test-key" } : base;
  const shadow: Env = dbAvailable
    ? { ...base, AI_REVIEW_MODE: "shadow", ANTHROPIC_API_KEY: "test-key" }
    : base;

  async function run(env: Env, name: string) {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${name}` } });
    const scored = fixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, sample, env);
    const emitted = await emitCuratedCycle(cycle, env);
    return { token, emitted, cycle };
  }

  beforeAll(async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    resetCuratorModelCache();
  });

  beforeEach(async () => {
    reviewPick.mockReset();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const shifted = new Date(Date.now() - 2 * 3_600_000);
    await prisma.curatedAlert.updateMany({
      where: { createdAt: { gt: hourAgo } },
      data: { createdAt: shifted },
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("gate mode: a no_buy is not sent, but is recorded with an anchor to grade it by", async () => {
    reviewPick.mockResolvedValue(verdict("no_buy"));
    const { token, emitted } = await run(gate, "veto");
    expect(emitted).toBe(0);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);
    const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(review.decision).toBe("no_buy");
    expect(review.mode).toBe("gate");
    expect(review.curatedAlertId).toBeNull();
    expect(review.candidateOutcomeId).not.toBeNull();
  });

  it("gate mode: a vetoed token is not re-asked inside the cooldown", async () => {
    reviewPick.mockResolvedValue(verdict("no_buy"));
    const { token } = await run(gate, "cooldown");
    reviewPick.mockClear();
    const scored = fixture(token.mintAddress);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, gate);
    expect(await emitCuratedCycle(cycle, gate)).toBe(0);
    expect(reviewPick).not.toHaveBeenCalled();
  });

  it("gate mode: a buy is sent without the reviewer's reasoning on the public card, and linked to its review", async () => {
    reviewPick.mockResolvedValue(verdict("buy"));
    const { token, emitted } = await run(gate, "buy");
    expect(emitted).toBe(1);
    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(alert.reasons.some((r) => r.startsWith("AI: "))).toBe(false);
    const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(review.reasoning).toBe("said buy");
    expect(review.curatedAlertId).toBe(alert.id);
    expect(review.candidateOutcomeId).toBe(alert.candidateOutcomeId);
  });

  it("gate mode: a failed review fails open and records the error", async () => {
    reviewPick.mockResolvedValue({ ...verdict("buy"), verdict: null, error: "rate limited" });
    const { token, emitted } = await run(gate, "fail-open");
    expect(emitted).toBe(1);
    const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(review.decision).toBeNull();
    expect(review.error).toBe("rate limited");
  });

  it("shadow mode: the alert goes out regardless, and the review is recorded alongside it", async () => {
    reviewPick.mockResolvedValue(verdict("no_buy"));
    const { token, emitted } = await run(shadow, "shadow");
    expect(emitted).toBe(1);
    await vi.waitFor(async () => {
      const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
      expect(review.mode).toBe("shadow");
      expect(review.decision).toBe("no_buy");
    });
  });

  it("gate mode runs as shadow until the reviewer's graded record qualifies it", async () => {
    gateQualified.mockResolvedValueOnce(false);
    reviewPick.mockResolvedValue(verdict("no_buy"));
    const { token, emitted } = await run(gate, "unqualified");
    // A no_buy from an unproven reviewer cannot hold the alert back.
    expect(emitted).toBe(1);
    await vi.waitFor(async () => {
      const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
      expect(review.mode).toBe("shadow");
    });
  });

  it("gate mode with a usable learned blend holds back what the blend scores below its cutoff", async () => {
    // The blend trusts the reviewer's odds alone here: 2x odds of 0.2 fall below a 0.5 cutoff even
    // though the reviewer said "buy"; odds of 0.8 clear it even on a "no_buy".
    const blend = await prisma.aiBlendModel.create({
      data: {
        params: { kind: "ai-blend-v1", intercept: 0, wCurator: 0, wAi: 1, cutoff: 0.5, usable: true },
        metrics: { rows: 200, reason: "test" },
      },
    });
    resetAiBlendCache();
    gateQualified.mockResolvedValue(false);
    try {
      const withOdds = (decision: "buy" | "no_buy", p: number): AiReviewResult => ({
        ...verdict(decision),
        verdict: { ...verdict(decision).verdict!, probability2x: p },
        curatorProbability: 0.4,
      });
      reviewPick.mockResolvedValue(withOdds("buy", 0.2));
      const held = await run(gate, "blend-held");
      expect(held.emitted).toBe(0);
      const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: held.token.id } });
      expect(review.mode).toBe("gate");
      expect(review.curatorProbability).toBe(0.4);

      reviewPick.mockResolvedValue(withOdds("no_buy", 0.8));
      const sent = await run(gate, "blend-sent");
      expect(sent.emitted).toBe(1);
    } finally {
      gateQualified.mockResolvedValue(true);
      await prisma.aiBlendModel.delete({ where: { id: blend.id } });
      resetAiBlendCache();
    }
  });

  it("never calls the reviewer without a key", async () => {
    const { emitted } = await run({ ...base, AI_REVIEW_MODE: "gate", ANTHROPIC_API_KEY: "" }, "no-key");
    expect(emitted).toBe(1);
    expect(reviewPick).not.toHaveBeenCalled();
  });
});
