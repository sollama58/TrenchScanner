import { describe, expect, it } from "vitest";
import {
  ACTIVE_CONTESTANT_IDS,
  CONTESTANTS,
  CONTESTANT_IDS,
  contestantSpec,
  RETIRED_CONTESTANT_IDS,
  NARRATIVE_SEAT_FEATURES,
  ORDER_FLOW_FEATURES,
  TREES_NO_TOKENSAGE_CONTESTANT,
  TREES_NO_TOKENSAGE_FEATURES,
  HIGH_PRECISION_CUTOFF_SHARE,
  RECENT_HALF_LIFE_DAYS,
  SHARP_DEEP_TREES_CONTESTANT,
  SHARP_SURVIVOR_CONTESTANT,
  SHARP_TREES_CONTESTANT,
  TREES_RECENT_HALF_LIFE_DAYS,
  enabledContestants,
  isMemberLearner,
  isTraderMember,
  GEMS_CONTESTANT,
  GEMS_RECIPE,
  TRADER_CONTESTANT,
  WINNERS_CONTESTANT,
  WINNERS_RECIPE,
  WINNERS_SEAT_INPUTS,
} from "./contestants.js";
import { GEMERALD_GATE, passesModelGateOnFeatures, seatConsiders } from "./modelGate.js";
import { foundingLanes, recipeFamily, traitName } from "./evolution.js";
import { ALL_NARRATIVE_FEATURES } from "./narrativeFeatures.js";
import {
  LEARNER_FEATURE_NAMES,
  RETIRED_LEARNER_INPUTS,
  SAFETY_FEATURES,
  WINNER_FOLLOW_FEATURES,
} from "./features.js";
import {
  GATED_MIN_ROWS,
  gatedTrainingSet,
  NARRATIVE_BACKGROUND_KIND,
  NARRATIVE_MIN_ROWS,
  narrativeTrainingSet,
  type ExamEvidence,
} from "./trainingRun.js";
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

  it("points the Narrative model at every TokenSage input, the socials and the safety readings", () => {
    const recipe = CONTESTANTS.find((c) => c.id === "narrative")?.recipe;
    expect(recipe?.featureNames).toBe(NARRATIVE_SEAT_FEATURES);
    const tokenSage = LEARNER_FEATURE_NAMES.filter((f) => f.startsWith("ns"));
    expect(tokenSage.length).toBeGreaterThan(30);
    expect(NARRATIVE_SEAT_FEATURES.filter((f) => f.startsWith("ns"))).toEqual(tokenSage);
    expect(NARRATIVE_SEAT_FEATURES.filter((f) => !f.startsWith("ns"))).toEqual([
      ...SAFETY_FEATURES,
      "hasTwitter",
      "hasWebsite",
    ]);
    // The story carries a fixed 30% of the decision, the safety readings the rest.
    expect(recipe?.narrativeLed).toBe(0.3);
    // No price, volume or age.
    for (const market of ["ageMinutes", "volumeAccel", "holderGrowth10mPct", "pathRet15mPct", "mcapUsd"]) {
      expect(NARRATIVE_SEAT_FEATURES).not.toContain(market);
    }
    expect(SAFETY_FEATURES).toContain("top10HolderPct");
    expect(SAFETY_FEATURES.every((f) => LEARNER_FEATURE_NAMES.includes(f))).toBe(true);
  });

  it("keeps a Trees twin that reads every learner input but TokenSage's", () => {
    const spec = CONTESTANTS.find((c) => c.id === TREES_NO_TOKENSAGE_CONTESTANT)!;
    expect(spec.role).toBe("learner");
    expect(spec.control).toBe(true);
    expect(spec.recipe).toEqual({
      learner: "gbdt",
      featureNames: TREES_NO_TOKENSAGE_FEATURES,
      goal: "return",
    });
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

describe("the high-precision seats", () => {
  it("are learners at their own share cutoff, outside the combiners and evolution, and can be the default", () => {
    for (const id of [SHARP_TREES_CONTESTANT, SHARP_SURVIVOR_CONTESTANT]) {
      const spec = contestantSpec(id)!;
      expect(spec.role).toBe("learner");
      expect(spec.standalone).toBe(true);
      expect(spec.control).toBeUndefined();
      expect(spec.recipe?.cutoffShare).toBe(HIGH_PRECISION_CUTOFF_SHARE);
      expect(isMemberLearner(spec)).toBe(false);
      expect(ACTIVE_CONTESTANT_IDS).toContain(id);
    }
    expect(contestantSpec(SHARP_TREES_CONTESTANT)!.recipe?.boosting?.minLeafRows).toBe(100);
    // Sharp Survivor is Survivor's two-stage recipe at the tight cutoff, not a copy of a member.
    expect(contestantSpec(SHARP_SURVIVOR_CONTESTANT)!.recipe).toEqual({
      learner: "gbdt",
      twoStage: true,
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "2x",
    });
    expect(contestantSpec(SHARP_SURVIVOR_CONTESTANT)!.name).toBe("Sharp 2x Survivor");
    expect(enabledContestants(["consensus", "linear", SHARP_TREES_CONTESTANT]).map((c) => c.id)).toEqual([
      "rules",
      "linear",
      SHARP_TREES_CONTESTANT,
    ]);
    expect(foundingLanes(CONTESTANTS, new Date(0)).map((l) => l.slot)).not.toContain(SHARP_TREES_CONTESTANT);
    expect(foundingLanes(CONTESTANTS, new Date(0)).map((l) => l.slot)).not.toContain(
      SHARP_SURVIVOR_CONTESTANT,
    );
  });

  it("retires Sharp Deep Trees, a copy of Deep Trees, under its own id instead of reusing it", () => {
    const old = contestantSpec(SHARP_DEEP_TREES_CONTESTANT)!;
    expect(old.retired).toBe(true);
    expect(old.name).toBe("Sharp Deep Trees");
    expect(RETIRED_CONTESTANT_IDS).toContain(SHARP_DEEP_TREES_CONTESTANT);
    expect(ACTIVE_CONTESTANT_IDS).not.toContain(SHARP_DEEP_TREES_CONTESTANT);
    expect(SHARP_SURVIVOR_CONTESTANT).not.toBe(SHARP_DEEP_TREES_CONTESTANT);
    // A configured roster that still names it drops it rather than training it.
    expect(
      enabledContestants(["linear", "trees", SHARP_DEEP_TREES_CONTESTANT]).map((c) => c.id),
    ).not.toContain(SHARP_DEEP_TREES_CONTESTANT);
  });
});

describe("Trees Recent", () => {
  it("runs a 1.5-day half-life trial of its own while Linear Recent keeps 3 days, in the same family", () => {
    expect(TREES_RECENT_HALF_LIFE_DAYS).toBe(1.5);
    expect(contestantSpec("trees-recent")!.recipe).toEqual({
      learner: "gbdt",
      recencyHalfLifeDays: TREES_RECENT_HALF_LIFE_DAYS,
      goal: "return",
    });
    expect(contestantSpec("linear-recent")!.recipe?.recencyHalfLifeDays).toBe(RECENT_HALF_LIFE_DAYS);
    expect(RECENT_HALF_LIFE_DAYS).toBe(3);
    // Still a member learner on its founding lane: the change reaches it, under the same name.
    const recipe = contestantSpec("trees-recent")!.recipe!;
    expect(recipeFamily(recipe)).toBe(recipeFamily(contestantSpec("trees")!.recipe!));
    expect(traitName(recipe, 14)).toBe("Return Trees Recent");
    expect(foundingLanes(CONTESTANTS, new Date(0)).find((l) => l.slot === "trees-recent")?.recipe).toEqual(
      recipe,
    );
  });
});

describe("a retired seat", () => {
  it("leaves the roster, the combiners' members and the default list, but keeps its spec", () => {
    expect(RETIRED_CONTESTANT_IDS).toEqual(["ranker", SHARP_DEEP_TREES_CONTESTANT]);
    expect(contestantSpec("ranker")?.name).toBe("Ranker");
    expect(enabledContestants(["consensus", "linear", "trees", "ranker"]).map((c) => c.id)).toEqual([
      "consensus",
      "rules",
      "linear",
      "trees",
    ]);
    expect(ACTIVE_CONTESTANT_IDS).not.toContain("ranker");
    expect(foundingLanes(CONTESTANTS, new Date(0)).map((l) => l.slot)).not.toContain("ranker");
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

describe("Gems", () => {
  it("is a standalone learner on the Gemerald gate, with the leading seats' traits, outside every combiner", () => {
    const spec = contestantSpec(GEMS_CONTESTANT)!;
    expect(spec.name).toBe("Return Gems");
    expect(spec.role).toBe("learner");
    expect(spec.standalone).toBe(true);
    expect(spec.gate).toBe(GEMERALD_GATE);
    expect(spec.recipe).toBe(GEMS_RECIPE);
    // Survivor's two stages, Simple Trees' inputs, Linear Recent's memory, the Sharp seats' cutoff.
    expect(GEMS_RECIPE).toEqual({
      learner: "gbdt",
      twoStage: true,
      featureNames: TREES_NO_TOKENSAGE_FEATURES,
      recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS,
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "return",
    });
    expect(isMemberLearner(spec)).toBe(false);
    expect(isTraderMember(spec)).toBe(false);
    expect(ACTIVE_CONTESTANT_IDS).toContain(GEMS_CONTESTANT);
    expect(foundingLanes(CONTESTANTS, new Date(0)).map((l) => l.slot)).not.toContain(GEMS_CONTESTANT);
  });

  it("trains and sits its exam on the rows its gate lets through, and sits out without its gate", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const gate = { mcapMin: 0, mcapMax: 1e12, maxTop10HolderPct: 40 };
    const gated = gatedTrainingSet(rows, gate);
    expect(gated.every((r) => passesModelGateOnFeatures(r.features, gate))).toBe(true);
    expect(gated.length).toBeGreaterThan(GATED_MIN_ROWS);
    expect(gated.length).toBeLessThan(rows.length);

    const cfg = {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      // A cheaper recipe than Gems' own: the test is the gate, not the trees.
      contestants: enabledContestants([
        "consensus",
        TRADER_CONTESTANT,
        "linear",
        "trees",
        GEMS_CONTESTANT,
      ]).map((c) => (c.id === GEMS_CONTESTANT ? { ...c, recipe: { learner: "logistic" as const } } : c)),
    };
    const without = await runContestTraining(rows, cfg);
    expect(without.map((r) => r.contestant)).not.toContain(GEMS_CONTESTANT);

    const results = await runContestTraining(rows, { ...cfg, gates: { [GEMERALD_GATE]: gate } });
    const gems = results.find((r) => r.contestant === GEMS_CONTESTANT)!;
    expect(gems.metrics.gate).toEqual({
      id: GEMERALD_GATE,
      rows: gated.length,
      of: rows.length,
      uncheckedOffline: [],
    });
    expect(gems.metrics.exam).toBeDefined();
    for (const id of ["consensus", TRADER_CONTESTANT]) {
      const combiner = results.find((r) => r.contestant === id)!.params as StackedCuratorParams;
      expect(combiner.members.map((m) => m.contestant)).not.toContain(GEMS_CONTESTANT);
    }
  }, 120_000);
});

describe("Winners", () => {
  it("is a standalone learner on the clean-winner reading, the only seat reading it, outside every combiner", () => {
    const spec = contestantSpec(WINNERS_CONTESTANT)!;
    expect(spec.name).toBe("Return Winners");
    expect(spec.role).toBe("learner");
    expect(spec.standalone).toBe(true);
    expect(spec.requires).toBe("recentBuyersRead");
    expect(spec.gate).toBeUndefined();
    expect(WINNERS_RECIPE).toEqual({
      learner: "gbdt",
      twoStage: true,
      featureNames: [...TREES_NO_TOKENSAGE_FEATURES, ...WINNERS_SEAT_INPUTS],
      recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS,
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "return",
    });
    for (const name of WINNER_FOLLOW_FEATURES) expect(RETIRED_LEARNER_INPUTS.has(name)).toBe(true);
    // The shares and how winners trade, not the counts, which read lower on backfilled rows.
    expect(WINNERS_SEAT_INPUTS).not.toContain("cleanWinnerRecentBuyers");
    expect(WINNERS_SEAT_INPUTS).not.toContain("recentBuyersRead");
    expect(WINNERS_SEAT_INPUTS).toContain("cleanWinnerNetShare");
    expect(isMemberLearner(spec)).toBe(false);
    expect(isTraderMember(spec)).toBe(false);
    expect(ACTIVE_CONTESTANT_IDS).toContain(WINNERS_CONTESTANT);
    expect(foundingLanes(CONTESTANTS, new Date(0)).map((l) => l.slot)).not.toContain(WINNERS_CONTESTANT);
  });

  it("considers only moments carrying its reading", () => {
    const spec = contestantSpec(WINNERS_CONTESTANT)!;
    expect(seatConsiders(spec, { recentBuyersRead: 40 }, undefined)).toBe(true);
    expect(seatConsiders(spec, { recentBuyersRead: 0 }, undefined)).toBe(true);
    expect(seatConsiders(spec, { recentBuyersRead: null }, undefined)).toBe(false);
    expect(seatConsiders(spec, {}, undefined)).toBe(false);
    // A gated seat without its stored gate considers nothing; a plain seat everything.
    expect(seatConsiders({ gate: GEMERALD_GATE }, { recentBuyersRead: 40 }, undefined)).toBe(false);
    expect(seatConsiders({}, {}, undefined)).toBe(true);
  });

  it("trains and sits its exam on the rows carrying its reading, and sits out with too few", async () => {
    const market = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    // Half the rows carry the reading (the live tape was read), the rest don't.
    const rows = market.map((r, i) =>
      i % 2 === 0
        ? {
            ...r,
            features: {
              ...r.features,
              cleanWinnerRecentBuyers: i % 7,
              cleanWinnerRecentShare: (i % 7) / 50,
              cleanWinnerBuySolShare: (i % 5) / 20,
              recentBuyersOwn2xMean: 0.05 + (i % 3) / 100,
              recentBuyersRead: 50,
            },
          }
        : r,
    );
    const carrying = rows.filter((r) => typeof r.features.recentBuyersRead === "number").length;
    const cfg = {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      // A cheaper recipe than its own: the test is the population, not the trees.
      contestants: enabledContestants([
        "consensus",
        TRADER_CONTESTANT,
        "linear",
        "trees",
        WINNERS_CONTESTANT,
      ]).map((c) =>
        c.id === WINNERS_CONTESTANT
          ? { ...c, recipe: { learner: "logistic" as const, featureNames: WINNERS_RECIPE.featureNames } }
          : c,
      ),
    };
    const results = await runContestTraining(rows, cfg);
    const winners = results.find((r) => r.contestant === WINNERS_CONTESTANT)!;
    expect(winners.metrics.gate).toEqual({
      id: "requires:recentBuyersRead",
      rows: carrying,
      of: rows.length,
      uncheckedOffline: [],
    });
    expect(winners.metrics.exam).toBeDefined();
    for (const id of ["consensus", TRADER_CONTESTANT]) {
      const combiner = results.find((r) => r.contestant === id)!.params as StackedCuratorParams;
      expect(combiner.members.map((m) => m.contestant)).not.toContain(WINNERS_CONTESTANT);
    }
    // No row carrying the reading: it sits the run out.
    const none = await runContestTraining(market, cfg);
    expect(none.map((r) => r.contestant)).not.toContain(WINNERS_CONTESTANT);
  }, 120_000);
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
    expect(outcome.probation!.laneName).toBe("Return Order Flow");
    // The seat keeps its own model this run.
    const seat = outcome.results.find((r) => r.contestant === "order-flow")!;
    expect(seat.metrics.contestantName).toBe("Return Order Flow");
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
