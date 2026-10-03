import { describe, expect, it } from "vitest";
import { CONTESTANTS, CONTESTANT_IDS, enabledContestants } from "./contestants.js";
import {
  defaultContestant,
  NEVER_EMIT_THRESHOLD,
  runContestTraining,
  runEvolvingContest,
} from "./trainingRun.js";
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

describe("runEvolvingContest", () => {
  it("swaps a winning challenger into its seat before the consensus is stacked", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 12 });
    const bred = {
      recipe: { learner: "gbdt" as const, recencyHalfLifeDays: 10, boosting: { maxDepth: 4 } },
      name: "Trees #1",
      description: "test",
      generation: 1,
      parentName: "Trees",
    };
    let seen: Map<string, number | null> | null = null;
    const outcome = await runEvolvingContest(
      rows,
      {
        targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
        targetPerHour: 6,
        heuristicMinScore: 55,
        minRowsToPromote: 1500,
        recencyHalfLifeDays: 14,
        cooldownHours: 24,
        heuristicPrecisionGate: true,
        contestants: enabledContestants(["consensus", "linear", "order-flow"]),
      },
      {
        challengers: [bred],
        decide: (laneScores, challengerScores) => {
          seen = laneScores;
          return challengerScores[0] === null ? null : { slot: "order-flow", challenger: 0, reason: "test" };
        },
      },
    );
    expect([...seen!.keys()]).toEqual(["linear", "order-flow"]);
    expect(outcome.challengerScores).toHaveLength(1);
    expect(outcome.challengerScores[0]).not.toBeNull();
    expect(outcome.replacement).toMatchObject({ slot: "order-flow", bred: { name: "Trees #1" } });
    const seat = outcome.results.find((r) => r.contestant === "order-flow")!;
    expect(seat.params.kind).toBe("gbdt-v1");
    expect(seat.metrics).toMatchObject({ contestant: "order-flow", contestantName: "Trees #1" });
    const consensus = outcome.results.find((r) => r.contestant === "consensus")!
      .params as StackedCuratorParams;
    expect(consensus.members.map((m) => m.contestant).sort()).toEqual(["linear", "order-flow"]);
  }, 60_000);
});
