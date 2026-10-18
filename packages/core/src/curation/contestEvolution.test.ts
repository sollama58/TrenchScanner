// Split out of contest.test.ts: each of these trains a field of seats, and a file runs its tests
// one after another, so they get files of their own to train side by side with the rest.
import { describe, expect, it } from "vitest";
import { enabledContestants } from "./contestants.js";
import { runEvolvingContest, type ExamEvidence } from "./trainingRun.js";
import { syntheticMarket } from "./syntheticMarket.js";
import type { StackedCuratorParams } from "./stacking.js";

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

describe("takeover probation and the exam's calls", () => {
  const cfg = {
    targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
    targetPerHour: 6,
    heuristicMinScore: 55,
    minRowsToPromote: 1500,
    recencyHalfLifeDays: 14,
    cooldownHours: 24,
    heuristicPrecisionGate: true,
    contestants: enabledContestants(["linear", "order-flow"]),
  };
  const bred = {
    recipe: { learner: "gbdt" as const, recencyHalfLifeDays: 10, boosting: { maxDepth: 4 } },
    name: "Trees #1",
    description: "test",
    generation: 1,
    parentName: "Trees",
  };

  it("holds a decided takeover on probation, with both models frozen, and leaves the seat alone", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 12 });
    let callsSeen: ExamEvidence | null = null;
    const outcome = await runEvolvingContest(rows, cfg, {
      challengers: [bred],
      probation: true,
      decide: (_lanes, challengerScores, exam) => {
        callsSeen = exam;
        return challengerScores[0] === null ? null : { slot: "order-flow", challenger: 0, reason: "test" };
      },
    });
    expect(outcome.replacement).toBeNull();
    expect(outcome.dropped).toBeNull();
    expect(outcome.probation).toMatchObject({ slot: "order-flow", bred: { name: "Trees #1" } });
    expect(outcome.probation!.challengerParams.kind).toBe("gbdt-v1");
    expect(outcome.probation!.laneName).toBe("Order Flow");
    // The seat keeps its own model this run.
    const seat = outcome.results.find((r) => r.contestant === "order-flow")!;
    expect(seat.metrics.contestantName).toBe("Order Flow");
    // The bootstrap's masks are the calls the exam record counts: one call per mask entry.
    const linear = outcome.results.find((r) => r.contestant === "linear")!;
    const seen = callsSeen!;
    const mask = seen.laneCalls.get("linear");
    if (mask) expect(mask.reduce((n, c) => n + c, 0)).toBe(linear.metrics.exam!.calls);
    // And the rank arrays the takeover's equal-share comparison draws from line up with them.
    expect(seen.moments).toHaveLength(seen.labels.length);
    expect(seen.cooldownMs).toBe(24 * 3_600_000);
    expect(seen.laneRanks.get("linear")).toHaveLength(seen.labels.length);
    if (seen.challengerCalls[0]) expect(seen.challengerRanks[0]).toHaveLength(seen.labels.length);
  }, 60_000);

  it("reports a decided takeover it can't carry out instead of dropping it silently", async () => {
    const rows = syntheticMarket({ tokens: 1500, days: 20, truth: "interactions", seed: 3 });
    const outcome = await runEvolvingContest(rows, cfg, {
      challengers: [bred, { ...bred, name: "Trees #2", generation: 2 }],
      decide: (_lanes, scores) =>
        scores.every((x) => x === null) ? null : { slot: "order-flow", challenger: 9, reason: "test" },
    });
    expect(outcome.replacement).toBeNull();
    if (outcome.challengerScores.some((x) => x !== null)) expect(outcome.dropped).toMatch(/order-flow/);
  }, 60_000);
});
