// Split out of contest.test.ts: each of these trains a field of seats, and a file runs its tests
// one after another, so they get files of their own to train side by side with the rest.
import { describe, expect, it } from "vitest";
import {
  HIGH_PRECISION_CUTOFF_SHARE,
  ORDER_FLOW_FEATURES,
  SHARP_TREES_CONTESTANT,
  TREES_NO_TOKENSAGE_CONTESTANT,
  enabledContestants,
} from "./contestants.js";
import { runContestTraining } from "./trainingRun.js";
import { syntheticMarket } from "./syntheticMarket.js";
import type { StackedCuratorParams } from "./stacking.js";

describe("runContestTraining", () => {
  it("ships one model per contestant and stacks the consensus on the learners", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const results = await runContestTraining(rows, {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["consensus", "linear", "order-flow", "trees"]),
    });
    expect(results.map((r) => r.contestant)).toEqual(["consensus", "rules", "linear", "order-flow", "trees"]);
    for (const r of results) {
      expect(r.metrics.contestant).toBe(r.contestant);
      expect(r.metrics.exam).toBeDefined();
    }
    const orderFlow = results.find((r) => r.contestant === "order-flow")!.params as {
      featureNames: string[];
    };
    expect(orderFlow.featureNames).toEqual([...ORDER_FLOW_FEATURES]);
    const consensus = results.find((r) => r.contestant === "consensus")!.params as StackedCuratorParams;
    expect(consensus.members.map((m) => m.contestant)).toEqual(["linear", "order-flow", "trees"]);
    expect(consensus.members.every((m) => m.quantiles.length > 0)).toBe(true);
  }, 60_000);

  it("ships a control seat on its own ledger without stacking it into the combiners", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const results = await runContestTraining(rows, {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants([
        "consensus",
        "blend",
        "linear",
        "trees",
        TREES_NO_TOKENSAGE_CONTESTANT,
      ]),
    });
    const control = results.find((r) => r.contestant === TREES_NO_TOKENSAGE_CONTESTANT)!;
    expect(control.metrics.exam).toBeDefined();
    for (const id of ["consensus", "blend"]) {
      const combiner = results.find((r) => r.contestant === id)!.params as StackedCuratorParams;
      expect(combiner.members.map((m) => m.contestant)).toEqual(["linear", "trees"]);
    }
  }, 60_000);
});

describe("a high-precision seat in the contest", () => {
  it("calls a narrower slice than the field and is stacked by no combiner", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const results = await runContestTraining(rows, {
      // The field's rule as production runs it: anchored on the top third of moments.
      targets: {
        winRate: 0.75,
        goalRate: 0.5,
        minSupport: 30,
        confidenceZ: 1,
        targetShare: 0.33,
        shareBand: 0.1,
        shareHurdle: 0.01,
      },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["consensus", "linear", "trees", SHARP_TREES_CONTESTANT]).map((c) =>
        c.id === SHARP_TREES_CONTESTANT
          ? { ...c, recipe: { learner: "gbdt" as const, cutoffShare: HIGH_PRECISION_CUTOFF_SHARE } }
          : c,
      ),
    });
    const trees = results.find((r) => r.contestant === "trees")!;
    const sharp = results.find((r) => r.contestant === SHARP_TREES_CONTESTANT)!;
    expect(sharp.metrics.exam!.calls).toBeGreaterThan(0);
    expect(sharp.metrics.precisionCalibration!.support).toBeLessThan(
      trees.metrics.precisionCalibration!.support,
    );
    const consensus = results.find((r) => r.contestant === "consensus")!.params as StackedCuratorParams;
    expect(consensus.members.map((m) => m.contestant)).toEqual(["linear", "trees"]);
  }, 60_000);
});
