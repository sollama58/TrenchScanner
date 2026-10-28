// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, resetAiReviewerSwitchCache, type Env, type ScoredToken } from "@trenchscanner/core";
import {
  collectCuratedContender,
  drainShadowReviews,
  emitCuratedCycle,
  newCuratedCycle,
  resetCuratorModelCache,
  resetSharedReviews,
} from "./curatedAlerts.js";
import { recordCandidateSample } from "./candidateOutcomeJob.js";
import type { AiReviewResult } from "../ai/reviewer.js";
import { resetAiBlendCache } from "../ai/blend.js";
import { ensureActivePlaybook, resetActivePlaybookCache } from "../ai/playbookStore.js";

const reviewPick = vi.fn<() => Promise<AiReviewResult | null>>();
/** Whether the reviewer has earned gate mode - true unless a test says otherwise. */
const gateQualified = vi.fn(async () => true);
vi.mock("../ai/reviewer.js", () => ({
  aiReviewEnabled: (env: Env) => env.AI_REVIEW_MODE !== "off" && env.ANTHROPIC_API_KEY !== "",
  aiGateQualified: () => gateQualified(),
  reviewPick: () => reviewPick(),
  // The heuristic's picks carry no tier; every one counts as a pick the reviewer is pointed at here.
  reviewPriority: () => "live",
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
    // Gate mode needs the Admin switch on live; the tests below that say otherwise set it.
    resetAiReviewerSwitchCache("live");
    reviewPick.mockReset();
    resetSharedReviews();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const shifted = new Date(Date.now() - 2 * 3_600_000);
    await prisma.curatedAlert.updateMany({
      where: { createdAt: { gt: hourAgo } },
      data: { createdAt: shifted },
    });
  });

  afterAll(async () => {
    resetAiReviewerSwitchCache();
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

  it("files a call on a coin whose ticker was launched again and again just before it (no relaunch block)", async () => {
    const filed = async (name: string, extra: Partial<ScoredToken>) => {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${name}` } });
      const cycle = newCuratedCycle();
      await collectCuratedContender(cycle, token, { ...fixture(token.mintAddress), ...extra }, null, shadow);
      return [...cycle.byModel.values()].reduce((n, list) => n + list.length, 0);
    };
    // User decision 2026-10-19: the block's copies doubled as often as the calls made.
    expect(
      await filed("copies", { relaunchSiblings: 12, relaunchSiblingPeakMcapUsd: 3_000 }),
    ).toBeGreaterThan(0);
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

  it("gate mode: a token called again inside the cooldown reuses its review, and records it once", async () => {
    reviewPick.mockResolvedValue(verdict("buy"));
    const { token, emitted } = await run(gate, "shared");
    expect(emitted).toBe(1);
    // The ledger's own cooldown lapses (another seat, or a later call): the coin goes out again on
    // the review it already has.
    await prisma.curatedAlert.updateMany({
      where: { tokenId: token.id },
      data: { createdAt: new Date(Date.now() - 7 * 86_400_000) },
    });
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, fixture(token.mintAddress), null, gate);
    expect(await emitCuratedCycle(cycle, gate)).toBe(1);
    expect(reviewPick).toHaveBeenCalledTimes(1);
    expect(await prisma.aiReview.count({ where: { tokenId: token.id } })).toBe(1);
  });

  it("gate mode: a failed review fails open and records the error", async () => {
    reviewPick.mockResolvedValue({ ...verdict("buy"), verdict: null, error: "rate limited" });
    const { token, emitted } = await run(gate, "fail-open");
    expect(emitted).toBe(1);
    const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(review.decision).toBeNull();
    expect(review.error).toBe("rate limited");
  });

  it("gate mode: a pick the budget can't pay for goes out unreviewed, with no review recorded", async () => {
    reviewPick.mockResolvedValue(null);
    const { token, emitted } = await run(gate, "over-budget");
    expect(emitted).toBe(1);
    expect(reviewPick).toHaveBeenCalledTimes(1);
    expect(await prisma.aiReview.count({ where: { tokenId: token.id } })).toBe(0);
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

  // User ask 2026-10-23 (API audit bundle, A4): a coin another seat or an earlier process already
  // had reviewed is not bought a second review in shadow mode; only the first counts anyway.
  describe("a review already stored for the token", () => {
    async function seeded(name: string, hoursAgo: number) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${name}` } });
      await prisma.aiReview.create({
        data: {
          tokenId: token.id,
          createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
          mode: "shadow",
          model: "claude-opus-5-5",
          decision: "buy",
          latencyMs: 1,
          anchorPriceUsd: 0.0001,
          anchorMcapUsd: 150_000,
        },
      });
      return token;
    }
    async function emit(token: { id: string; mintAddress: string }, env: Env) {
      const cycle = newCuratedCycle();
      await collectCuratedContender(cycle, token, fixture(token.mintAddress), null, env);
      const emitted = await emitCuratedCycle(cycle, env);
      await drainShadowReviews(10_000);
      return emitted;
    }

    it("shadow mode: reuses one from within the alert cooldown, past the in-process share", async () => {
      reviewPick.mockResolvedValue(verdict("no_buy"));
      const token = await seeded("stored-shadow", 2);
      expect(await emit(token, shadow)).toBe(1);
      expect(reviewPick).not.toHaveBeenCalled();
      expect(await prisma.aiReview.count({ where: { tokenId: token.id } })).toBe(1);
    });

    it("shadow mode: asks again once the stored one is older than the alert cooldown", async () => {
      reviewPick.mockResolvedValue(verdict("no_buy"));
      const token = await seeded("stored-old", shadow.CURATED_ALERT_COOLDOWN_HOURS + 1);
      expect(await emit(token, shadow)).toBe(1);
      expect(reviewPick).toHaveBeenCalledTimes(1);
      expect(await prisma.aiReview.count({ where: { tokenId: token.id } })).toBe(2);
    });

    it("gate mode: does not let a stored verdict past the half-hour share decide the pick", async () => {
      reviewPick.mockResolvedValue(verdict("no_buy"));
      const token = await seeded("stored-gate", 2);
      expect(await emit(token, gate)).toBe(0);
      expect(reviewPick).toHaveBeenCalledTimes(1);
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
    // though the reviewer said "buy"; odds of 0.8 clear it even on a "no_buy". It was fitted on
    // the active playbook's reviews, the only blend that may gate (worker ai/blend.ts).
    resetActivePlaybookCache();
    const playbook = await ensureActivePlaybook();
    const blend = await prisma.aiBlendModel.create({
      data: {
        params: {
          kind: "ai-blend-v1",
          intercept: 0,
          wCurator: 0,
          wAi: 1,
          cutoff: 0.5,
          usable: true,
          playbookId: playbook.id,
        },
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

  it("gate mode ignores a usable blend fitted on another playbook's reviews", async () => {
    const blend = await prisma.aiBlendModel.create({
      data: {
        params: {
          kind: "ai-blend-v1",
          intercept: 0,
          wCurator: 0,
          wAi: 1,
          cutoff: 0.5,
          usable: true,
          playbookId: "an-older-playbook",
        },
        metrics: { rows: 200, reason: "test" },
      },
    });
    resetActivePlaybookCache();
    resetAiBlendCache();
    gateQualified.mockResolvedValue(false);
    try {
      reviewPick.mockResolvedValue({
        ...verdict("buy"),
        verdict: { ...verdict("buy").verdict!, probability2x: 0.2 },
        curatorProbability: 0.4,
      });
      // The current playbook has no record and no blend of its own: shadow, nothing held back.
      const { emitted } = await run(gate, "blend-other-playbook");
      expect(emitted).toBe(1);
    } finally {
      gateQualified.mockResolvedValue(true);
      await prisma.aiBlendModel.delete({ where: { id: blend.id } });
      resetAiBlendCache();
    }
  });

  it("with the Admin switch on test (admins only), gate mode runs as shadow and holds nothing back", async () => {
    resetAiReviewerSwitchCache("admins");
    reviewPick.mockResolvedValue(verdict("no_buy"));
    const { token, emitted } = await run(gate, "switch-admins");
    expect(emitted).toBe(1);
    await vi.waitFor(async () => {
      const review = await prisma.aiReview.findFirstOrThrow({ where: { tokenId: token.id } });
      expect(review.mode).toBe("shadow");
      expect(review.decision).toBe("no_buy");
    });
  });

  it("never calls the reviewer with the Admin switch off, key or not", async () => {
    resetAiReviewerSwitchCache("off");
    const { emitted } = await run(shadow, "switch-off");
    expect(emitted).toBe(1);
    expect(reviewPick).not.toHaveBeenCalled();
  });

  it("never calls the reviewer without a key", async () => {
    const { emitted } = await run({ ...base, AI_REVIEW_MODE: "gate", ANTHROPIC_API_KEY: "" }, "no-key");
    expect(emitted).toBe(1);
    expect(reviewPick).not.toHaveBeenCalled();
  });
});
