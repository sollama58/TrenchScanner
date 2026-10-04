import { describe, expect, it } from "vitest";
import { decidePlaybookPromotion, summarizeJudgeRecord, type JudgedCall } from "./aiJudge.js";
import { trainBoostedCurator } from "./boosting.js";
import { pickChampion, type ChampionStanding } from "./champion.js";
import type { CompositeScore } from "./leaderboard.js";
import { scoreCandidateWithModel, trainCurator, type PrecisionTargets, type TrainingRow } from "./trainer.js";

/** Fixes from the 2026-10-04 models-and-training bug audit. */

function rows(n: number, opts: { legacy?: boolean } = {}): TrainingRow[] {
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const x = (i % 10) / 10;
    return {
      anchorAt: new Date(t0 + i * 60_000),
      features: { mcapUsd: 10_000 + 1_000 * x, textHypeScore: null },
      labelValue: i % 3 === 0 ? 1 : 0,
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      ...(opts.legacy ? { labelRule: 1 } : {}),
    };
  });
}

describe("trainCurator with a feature never present", () => {
  it("leaves its weights at zero, so its arrival doesn't move scores", async () => {
    const params = await trainCurator(rows(120), { featureNames: ["mcapUsd", "textHypeScore"] });
    const j = params.featureNames.indexOf("textHypeScore");
    const n = params.featureNames.length;
    expect(params.weights[j]).toBe(0);
    expect(params.weights[n + j]).toBe(0);
    const without = scoreCandidateWithModel(params, { mcapUsd: 10_500, textHypeScore: null });
    const withText = scoreCandidateWithModel(params, { mcapUsd: 10_500, textHypeScore: 0.9 });
    expect(withText).toBeCloseTo(without, 12);
  });
});

describe("a legacy weight of 0 on an all-legacy slice", () => {
  it("trains finite models instead of NaN", async () => {
    const legacy = rows(120, { legacy: true });
    const logistic = await trainCurator(legacy, { featureNames: ["mcapUsd"], legacyLabelWeight: 0 });
    expect(logistic.weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(logistic.bias)).toBe(true);
    const boosted = await trainBoostedCurator(legacy, { legacyLabelWeight: 0 });
    expect(Number.isFinite(scoreCandidateWithModel(boosted, legacy[0]!.features))).toBe(true);
  });
});

function standing(id: string, score: number, liveGraded: number): ChampionStanding {
  const summary = {
    calls: liveGraded,
    graded: liveGraded,
    winRatePct: null,
    goalRatePct: null,
    avgReturnDoublings: null,
    score,
  };
  const composite: CompositeScore = {
    score,
    liveWeight: 0.5,
    warmingUp: liveGraded < 50,
    live: summary,
    exam: summary,
  };
  return { id, name: id.toUpperCase(), calling: true, composite };
}

describe("pickChampion across tiers", () => {
  it("lets a seasoned leader unseat a warming-up incumbent with a higher score", () => {
    const field = [standing("seasoned", 40, 80), standing("newcomer", 45, 12)];
    const pick = pickChampion(field, "newcomer", { minLiveGraded: 10, margin: 2 }, "rules");
    expect(pick.id).toBe("seasoned");
  });
});

describe("decidePlaybookPromotion with a silent incumbent", () => {
  const targets: PrecisionTargets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };
  const call = (decision: "buy" | "no_buy", labelValue: number): JudgedCall => ({
    decision,
    probability2x: 0.5,
    labelValue,
  });

  it("won't promote buys that do no better than the base rate", () => {
    // Incumbent never buys (score null). Candidate buys 12 at 50%, pool also wins 50%.
    const pool = [
      ...Array.from({ length: 12 }, (_, i) => call("buy", i % 2 ? 2 : 0)),
      ...Array.from({ length: 12 }, (_, i) => call("no_buy", i % 2 ? 2 : 0)),
    ];
    const incumbent = summarizeJudgeRecord(
      pool.map((c) => ({ ...c, decision: "no_buy" as const })),
      targets,
    );
    const candidate = summarizeJudgeRecord(pool, targets);
    expect(incumbent.score).toBeNull();
    expect(candidate.liftPts).toBe(0);
    expect(candidate.score).not.toBeNull();
    const d = decidePlaybookPromotion(incumbent, [{ id: "c", summary: candidate }], {
      minGain: 3,
      minBuys: 10,
    });
    expect(d.winner).toBeNull();
  });
});
