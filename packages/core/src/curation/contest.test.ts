import { describe, expect, it } from "vitest";
import { CONTESTANTS, CONTESTANT_IDS, enabledContestants } from "./contestants.js";
import { defaultContestant, NEVER_EMIT_THRESHOLD, runContestTraining } from "./trainingRun.js";
import { syntheticMarket } from "./syntheticMarket.js";
import type { StackedCuratorParams } from "./stacking.js";

describe("contestant roster", () => {
  it("has unique ids and names - the selector and the leaderboard share them", () => {
    expect(new Set(CONTESTANT_IDS).size).toBe(CONTESTANTS.length);
    expect(new Set(CONTESTANTS.map((c) => c.name)).size).toBe(CONTESTANTS.length);
  });

  it("always keeps Rules, and drops the consensus without two learners to stack", () => {
    expect(enabledContestants(["linear"]).map((c) => c.id)).toEqual(["rules", "linear"]);
    expect(enabledContestants(["consensus", "linear", "trees"]).map((c) => c.id)).toEqual([
      "consensus",
      "rules",
      "linear",
      "trees",
    ]);
  });
});

describe("defaultContestant", () => {
  it("is the consensus once it can call, Rules otherwise", () => {
    expect(defaultContestant(0.4)).toBe("consensus");
    expect(defaultContestant(NEVER_EMIT_THRESHOLD)).toBe("rules");
    expect(defaultContestant(null)).toBe("rules");
  });
});

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
    expect(orderFlow.featureNames.length).toBeLessThan(20);
    const consensus = results.find((r) => r.contestant === "consensus")!.params as StackedCuratorParams;
    expect(consensus.members.map((m) => m.contestant)).toEqual(["linear", "order-flow", "trees"]);
    expect(consensus.members.every((m) => m.quantiles.length > 0)).toBe(true);
  }, 60_000);
});
