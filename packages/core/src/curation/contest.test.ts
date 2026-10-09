import { describe, expect, it } from "vitest";
import {
  CONTESTANTS,
  CONTESTANT_IDS,
  NARRATIVE_SEAT_FEATURES,
  ORDER_FLOW_FEATURES,
  TREES_NO_TOKENSAGE_CONTESTANT,
  TREES_NO_TOKENSAGE_FEATURES,
  enabledContestants,
} from "./contestants.js";
import { foundingLanes } from "./evolution.js";
import { ALL_NARRATIVE_FEATURES } from "./narrativeFeatures.js";
import { LEARNER_FEATURE_NAMES } from "./features.js";
import { NARRATIVE_BACKGROUND_KIND, NARRATIVE_MIN_ROWS, narrativeTrainingSet } from "./trainingRun.js";
import { isDecisionRow, type TrainingRow } from "./trainer.js";
import { STACKED_MODEL_KIND } from "./stacking.js";
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

  it("seats the Narrative model without counting it as a learner the combiners stack on", () => {
    expect(enabledContestants(["consensus", "linear", "narrative"]).map((c) => c.id)).toEqual([
      "rules",
      "linear",
      "narrative",
    ]);
    expect(CONTESTANTS.find((c) => c.id === "narrative")?.role).toBe("narrative");
  });

  it("points the Narrative model at every TokenSage input and only four market readings", () => {
    const recipe = CONTESTANTS.find((c) => c.id === "narrative")?.recipe;
    expect(recipe?.featureNames).toBe(NARRATIVE_SEAT_FEATURES);
    const tokenSage = LEARNER_FEATURE_NAMES.filter((f) => f.startsWith("ns"));
    expect(tokenSage.length).toBeGreaterThan(30);
    expect(NARRATIVE_SEAT_FEATURES.filter((f) => f.startsWith("ns"))).toEqual(tokenSage);
    expect(NARRATIVE_SEAT_FEATURES.filter((f) => !f.startsWith("ns"))).toEqual([
      "ageMinutes",
      "volumeAccel",
      "holderGrowth10mPct",
      "pathRet15mPct",
    ]);
  });

  it("keeps a Trees twin that reads every learner input but TokenSage's", () => {
    const spec = CONTESTANTS.find((c) => c.id === TREES_NO_TOKENSAGE_CONTESTANT)!;
    expect(spec.role).toBe("learner");
    expect(spec.control).toBe(true);
    expect(spec.recipe).toEqual({ learner: "gbdt", featureNames: TREES_NO_TOKENSAGE_FEATURES });
    const narrative = new Set<string>(ALL_NARRATIVE_FEATURES);
    expect(TREES_NO_TOKENSAGE_FEATURES.some((f) => f.startsWith("ns") || narrative.has(f))).toBe(false);
    expect(TREES_NO_TOKENSAGE_FEATURES).toEqual(
      LEARNER_FEATURE_NAMES.filter((f) => !f.startsWith("ns") && !narrative.has(f)),
    );
    expect(TREES_NO_TOKENSAGE_FEATURES.length).toBeGreaterThan(20);
  });

  it("doesn't count a control seat as a learner the combiners need, nor give it an evolution lane", () => {
    expect(
      enabledContestants(["consensus", "linear", TREES_NO_TOKENSAGE_CONTESTANT]).map((c) => c.id),
    ).toEqual(["rules", "linear", TREES_NO_TOKENSAGE_CONTESTANT]);
    expect(foundingLanes(CONTESTANTS, new Date(0)).map((l) => l.slot)).not.toContain(
      TREES_NO_TOKENSAGE_CONTESTANT,
    );
  });
});

describe("the Narrative seat's exam", () => {
  it("sits its own exam on its own rows, and sits out without enough of them", async () => {
    const rows = syntheticMarket({ tokens: 1200, days: 20, truth: "linear", seed: 21 });
    const cfg = {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["linear", "narrative", "narrative-blend"]),
    };
    const without = await runContestTraining(rows, {
      ...cfg,
      narrativeRows: rows.slice(0, NARRATIVE_MIN_ROWS - 1),
    });
    expect(without.map((r) => r.contestant)).toEqual(["rules", "linear"]);

    // The seat's rows carry the deep read; everything else about them is the usual market.
    const own = rows.map((r) => ({ ...r, features: { ...r.features, nsDepthFull: 1, nsCatAnimal: 1 } }));
    const results = await runContestTraining(rows, { ...cfg, narrativeRows: own });
    expect(results.map((r) => r.contestant)).toEqual(["rules", "linear", "narrative", "narrative-blend"]);
    for (const id of ["narrative", "narrative-blend"]) {
      const seat = results.find((r) => r.contestant === id)!;
      expect(seat.metrics.exam).toBeDefined();
      expect(seat.params.kind).not.toBe(STACKED_MODEL_KIND);
    }
  }, 60_000);

  it("trains on every row, but only the deep-read rows and second looks are its decision rows", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 8, 12, m));
    const row = (m: number, kind: string, deep: boolean): TrainingRow => ({
      features: deep ? { nsDepthFull: 1 } : { nsDepthFull: null },
      labelValue: 0,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      anchorAt: at(m),
      sampleKind: kind,
    });
    const second = row(3, "event", true);
    const set = narrativeTrainingSet(
      [row(1, "event", false), row(2, "event", true), row(4, "hourly", false), row(5, "hourly", true)],
      [second],
    );
    expect(set.map((r) => [r.anchorAt.getUTCMinutes(), r.sampleKind])).toEqual([
      [5, "hourly"],
      [4, NARRATIVE_BACKGROUND_KIND],
      [3, "event"],
      [2, "event"],
      [1, NARRATIVE_BACKGROUND_KIND],
    ]);
    expect(set.filter((r) => isDecisionRow(r)).map((r) => r.anchorAt.getUTCMinutes())).toEqual([3, 2]);
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
    let callsSeen: { lane: Map<string, Uint8Array>; challenger: (Uint8Array | null)[] } | null = null;
    const outcome = await runEvolvingContest(rows, cfg, {
      challengers: [bred],
      probation: true,
      decide: (_lanes, challengerScores, exam) => {
        callsSeen = { lane: exam.laneCalls, challenger: exam.challengerCalls };
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
    const mask = callsSeen!.lane.get("linear");
    if (mask) expect(mask.reduce((n, c) => n + c, 0)).toBe(linear.metrics.exam!.calls);
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
