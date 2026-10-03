import { describe, expect, it } from "vitest";
import {
  pickCuratorFamily,
  runCuratorTraining,
  NEVER_EMIT_THRESHOLD,
  type FamilyResult,
} from "./trainingRun.js";
import { calibrateThresholdForPrecision, wilsonLowerBound, type ScoredOutcome } from "./trainer.js";
import { syntheticMarket } from "./syntheticMarket.js";

const family = (
  learner: FamilyResult["learner"],
  threshold: number | null,
  support: number,
  winRatePct: number,
  promote = false,
): FamilyResult => ({
  learner,
  verdict: { promote, reason: "" },
  precisionCalibration: { threshold, meetsTargets: threshold !== null, support, winRatePct, goalRatePct: 50 },
});

describe("pickCuratorFamily", () => {
  it("prefers a family whose cutoff met the targets", () => {
    expect(pickCuratorFamily([family("logistic", null, 80, 70), family("gbdt", 0.9, 30, 76)])).toBe(1);
  });
  it("then the one whose exam earned promotion", () => {
    expect(pickCuratorFamily([family("logistic", 0.9, 60, 80), family("gbdt", 0.9, 30, 76, true)])).toBe(1);
  });
  it("then the one that sends more qualifying alerts", () => {
    expect(pickCuratorFamily([family("logistic", 0.9, 30, 90), family("gbdt", 0.8, 45, 77)])).toBe(1);
  });
  it("keeps the first family on an exact tie", () => {
    expect(pickCuratorFamily([family("logistic", null, 30, 60), family("gbdt", null, 30, 60)])).toBe(0);
  });
  it("among misses, keeps the closer one", () => {
    expect(pickCuratorFamily([family("logistic", null, 30, 60), family("gbdt", null, 30, 70)])).toBe(1);
  });
});

describe("wilsonLowerBound", () => {
  it("is the observed rate at z = 0 and shrinks thin records", () => {
    expect(wilsonLowerBound(23, 30, 0)).toBeCloseTo(23 / 30, 12);
    expect(wilsonLowerBound(23, 30, 1)).toBeLessThan(0.7);
    expect(wilsonLowerBound(230, 300, 1)).toBeGreaterThan(0.73);
    expect(wilsonLowerBound(0, 0, 1)).toBe(0);
  });
});

describe("calibrateThresholdForPrecision with confidenceZ", () => {
  // 40 calls: the top 30 win 24 times (80%), all reach 4x when they win.
  const calls: ScoredOutcome[] = Array.from({ length: 40 }, (_, i) => ({
    probability: 1 - i / 100,
    labelValue: i < 30 ? (i % 5 === 4 ? 0 : 2) : 0,
  }));
  const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30 };
  it("accepts the thin record on observed rates", () => {
    expect(calibrateThresholdForPrecision(calls, targets).meetsTargets).toBe(true);
  });
  it("rejects it once the lower bound has to clear the bar", () => {
    const strict = calibrateThresholdForPrecision(calls, { ...targets, confidenceZ: 1 });
    expect(strict.meetsTargets).toBe(false);
    // Missing the bar never stops the feed: there is still a cutoff to send at.
    expect(strict.threshold).not.toBeNull();
  });
});

describe("runCuratorTraining", () => {
  it("examines every family, records them all, and never promotes on noise", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "noise", seed: 4 });
    const run = await runCuratorTraining(rows, {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      learners: ["logistic", "gbdt"],
    });
    expect(run.metrics.familyComparison?.map((f) => f.learner)).toEqual(["logistic", "gbdt"]);
    expect(run.metrics.precisionCalibration.meetsTargets).toBe(false);
    expect(run.params.threshold).not.toBe(NEVER_EMIT_THRESHOLD);
    expect(run.metrics.verdict.promote).toBe(false);
  });
});
