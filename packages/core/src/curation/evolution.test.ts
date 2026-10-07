import { describe, expect, it } from "vitest";
import { CONTESTANTS, enabledContestants, CONTESTANT_IDS, type CuratorRecipe } from "./contestants.js";
import {
  breedChallengers,
  chooseReplacement,
  describeRecipe,
  foundingLanes,
  mutateRecipe,
  normalizeRecipe,
  plainSummary,
  recipeFamily,
  seededRng,
  traitName,
  withLanes,
  type Lane,
  type LaneFitness,
} from "./evolution.js";
import { CANDIDATE_FEATURE_NAMES } from "./features.js";

const BASE_HL = 14;
const t0 = new Date("2026-10-01T00:00:00Z");

function lane(slot: string, recipe: CuratorRecipe, bornAt = t0, name = slot): Lane {
  return { slot, name, description: "", recipe, generation: 0, parentName: null, bornAt };
}

describe("mutateRecipe", () => {
  it("always changes something and stays inside the search space", () => {
    const rng = seededRng(7);
    const parents: CuratorRecipe[] = CONTESTANTS.filter((c) => c.recipe).map((c) => c.recipe!);
    for (let i = 0; i < 400; i++) {
      const parent = parents[i % parents.length]!;
      const child = mutateRecipe(parent, rng, { baseHalfLifeDays: BASE_HL });
      expect(JSON.stringify(child)).not.toBe(JSON.stringify(normalizeRecipe(parent, BASE_HL)));
      expect(child.recencyHalfLifeDays).toBeGreaterThanOrEqual(1);
      expect(child.recencyHalfLifeDays).toBeLessThanOrEqual(60);
      if (child.learner === "gbdt") {
        const b = child.boosting!;
        expect(b.maxDepth).toBeGreaterThanOrEqual(2);
        expect(b.maxDepth).toBeLessThanOrEqual(6);
        expect(b.maxTrees).toBeLessThanOrEqual(400);
        expect(b.learningRate).toBeGreaterThanOrEqual(0.02);
        expect(b.rowSample).toBeLessThanOrEqual(1);
      } else if (child.featureNames) {
        expect(child.featureNames.length).toBeGreaterThanOrEqual(8);
        expect(child.featureNames.length).toBeLessThan(CANDIDATE_FEATURE_NAMES.length);
        for (const f of child.featureNames) expect(CANDIDATE_FEATURE_NAMES).toContain(f);
      }
    }
  });

  it("is deterministic for a seed", () => {
    const a = mutateRecipe({ learner: "gbdt" }, seededRng(42), { baseHalfLifeDays: BASE_HL });
    const b = mutateRecipe({ learner: "gbdt" }, seededRng(42), { baseHalfLifeDays: BASE_HL });
    expect(a).toEqual(b);
  });
});

describe("names", () => {
  it("names a recipe by family, depth, signals and memory", () => {
    expect(traitName({ learner: "logistic" }, BASE_HL)).toBe("Linear");
    expect(traitName({ learner: "gbdt", recencyHalfLifeDays: 3 }, BASE_HL)).toBe("Trees Recent");
    expect(traitName({ learner: "gbdt", boosting: { maxDepth: 5 } }, BASE_HL)).toBe("Deep Trees");
    const orderFlow = CONTESTANTS.find((c) => c.id === "order-flow")!.recipe!;
    expect(traitName(orderFlow, BASE_HL)).toBe("Order Flow");
    expect(
      traitName({ learner: "logistic", featureNames: ["mcapUsd"], recencyHalfLifeDays: 40 }, BASE_HL),
    ).toBe("Lean Linear Patient");
    expect(describeRecipe({ learner: "logistic" }, BASE_HL, "Linear")).toContain("Bred from Linear.");
  });
});

describe("breedChallengers", () => {
  const lanes = foundingLanes(enabledContestants(CONTESTANT_IDS), t0);
  const fitness: LaneFitness[] = lanes.map((l, i) => ({ lane: l, composite: 60 - i * 10 }));

  it("breeds unique, uniquely named challengers from the top half", () => {
    const bred = breedChallengers(fitness, 4, seededRng(3), {
      baseHalfLifeDays: BASE_HL,
      nextGeneration: 10,
    });
    expect(bred).toHaveLength(4);
    expect(bred.map((b) => b.generation)).toEqual([10, 11, 12, 13]);
    expect(new Set(bred.map((b) => b.name)).size).toBe(4);
    expect(bred.every((b) => b.name.endsWith(`#${b.generation}`))).toBe(true);
    const topNames = new Set(fitness.slice(0, Math.ceil(fitness.length / 2)).map((f) => f.lane.name));
    for (const b of bred) {
      for (const parent of b.parentName.split(" × ")) expect(topNames.has(parent)).toBe(true);
    }
    const onRoster = new Set(lanes.map((l) => JSON.stringify(normalizeRecipe(l.recipe, BASE_HL))));
    for (const b of bred) expect(onRoster.has(JSON.stringify(b.recipe))).toBe(false);
  });

  it("breeds from seasoned lanes before warming-up ones, whatever their score", () => {
    // The newest seat holds the exam that won it a run earlier - the optimistic draw - and no
    // live calls yet: it ranks behind every seasoned lane, as on the leaderboard.
    const seasonedFirst: LaneFitness[] = lanes.map((l, i) => ({
      lane: l,
      composite: i === 0 ? 90 : 60 - i * 5,
      liveGraded: i === 0 ? 3 : 120,
    }));
    const bred = breedChallengers(seasonedFirst, 6, seededRng(5), {
      baseHalfLifeDays: BASE_HL,
      nextGeneration: 1,
    });
    expect(bred.length).toBeGreaterThan(0);
    const parents = new Set(bred.flatMap((b) => b.parentName.split(" × ")));
    expect(parents.has(lanes[0]!.name)).toBe(false);
    // Without live counts, score alone orders them (the founding runs, before any live call).
    const byScore = breedChallengers(fitness, 6, seededRng(5), {
      baseHalfLifeDays: BASE_HL,
      nextGeneration: 1,
    });
    expect(byScore.some((b) => b.parentName.split(" × ").includes(lanes[0]!.name))).toBe(true);
  });

  it("breeds nothing when asked for none", () => {
    expect(
      breedChallengers(fitness, 0, seededRng(1), { baseHalfLifeDays: BASE_HL, nextGeneration: 1 }),
    ).toEqual([]);
  });
});

describe("chooseReplacement", () => {
  const now = new Date(t0.getTime() + 48 * 3_600_000);
  const seasoned = (slot: string, composite: number | null, examScore: number | null) => ({
    lane: lane(slot, { learner: "logistic" }),
    composite,
    examScore,
  });

  it("gives the weakest seasoned seat to the best challenger that clears the margin", () => {
    const r = chooseReplacement({
      lanes: [seasoned("a", 50, 48), seasoned("b", 20, 30), seasoned("c", 35, 40)],
      challengerScores: [31, 36, null],
      now,
      minAgeMs: 12 * 3_600_000,
      margin: 3,
    });
    expect(r).toMatchObject({ slot: "b", challenger: 1 });
  });

  it("keeps the seat when no challenger beats its exam by the margin", () => {
    const r = chooseReplacement({
      lanes: [seasoned("a", 50, 48), seasoned("b", 20, 30)],
      challengerScores: [32],
      now,
      minAgeMs: 0,
      margin: 3,
    });
    expect(r).toBeNull();
  });

  it("never replaces a seat younger than the minimum age, and treats unscored seats as weakest", () => {
    const young = {
      lane: lane("young", { learner: "gbdt" }, new Date(now.getTime() - 3_600_000)),
      composite: 1,
      examScore: 1,
    };
    const r = chooseReplacement({
      lanes: [young, seasoned("old", 70, 60), seasoned("silent", null, null)],
      challengerScores: [10],
      now,
      minAgeMs: 12 * 3_600_000,
      margin: 3,
    });
    expect(r?.slot).toBe("silent");
    expect(
      chooseReplacement({ lanes: [young], challengerScores: [99], now, minAgeMs: 12 * 3_600_000, margin: 0 }),
    ).toBeNull();
  });
});

describe("chooseReplacement keeps every family seated", () => {
  it("skips a family's last seat and takes the weakest of the challenger's own family instead", () => {
    const now = new Date(t0.getTime() + 48 * 3_600_000);
    const at = (slot: string, learner: "logistic" | "gbdt", composite: number) => ({
      lane: lane(slot, { learner }),
      composite,
      examScore: 20,
    });
    const lanes = [at("lin", "logistic", 10), at("t1", "gbdt", 30), at("t2", "gbdt", 40)];
    const base = { lanes, challengerScores: [50], now, minAgeMs: 0, margin: 3 };
    expect(chooseReplacement({ ...base, challengerLearners: ["gbdt"] })?.slot).toBe("t1");
    expect(chooseReplacement({ ...base, challengerLearners: ["logistic"] })?.slot).toBe("lin");
    expect(chooseReplacement(base)?.slot).toBe("lin");
  });
});

describe("withLanes", () => {
  it("swaps a learner seat's name, description and recipe for its lane's, leaving others alone", () => {
    const specs = enabledContestants(CONTESTANT_IDS);
    const bred: Lane = {
      slot: "linear",
      name: "Trees Recent #4",
      description: "bred",
      recipe: { learner: "gbdt", recencyHalfLifeDays: 2 },
      generation: 4,
      parentName: "Trees",
      bornAt: t0,
    };
    const out = withLanes(specs, [bred]);
    expect(out.find((s) => s.id === "linear")).toMatchObject({
      name: "Trees Recent #4",
      recipe: bred.recipe,
      summary:
        "Learns if-then rules from every signal, mostly remembering the last few days. A variant bred from Trees.",
    });
    expect(out.find((s) => s.id === "trees")?.name).toBe("Trees");
    expect(out.map((s) => s.id)).toEqual(specs.map((s) => s.id));
  });
});

describe("plainSummary", () => {
  it("gives every founding contestant a plain summary", () => {
    for (const c of CONTESTANTS) expect(c.summary, c.id).toBeTruthy();
  });

  it("describes a bred recipe without knob values", () => {
    const order = CONTESTANTS.find((c) => c.id === "order-flow")!.recipe!;
    expect(plainSummary(order, null)).toBe(
      "Weighs only the last few minutes of trading in one simple formula.",
    );
    expect(plainSummary({ learner: "gbdt", twoStage: true, boosting: { maxDepth: 5 } }, "Survivor")).toBe(
      "Asks first whether it avoids a 50% drop, then: learns long if-then chains from every signal. A variant bred from Survivor.",
    );
    expect(plainSummary({ learner: "logistic", recencyHalfLifeDays: 45 }, "Linear")).toMatch(/long memory/);
  });
});

describe("the forest and objective families", () => {
  it("normalizes, names and describes them, and keeps a seat's objective through mutation", () => {
    expect(traitName({ learner: "forest" }, BASE_HL)).toBe("Forest");
    expect(traitName({ learner: "forest", forest: { maxDepth: 8 }, recencyHalfLifeDays: 2 }, BASE_HL)).toBe(
      "Deep Forest Recent",
    );
    expect(traitName({ learner: "gbdt", boosting: { objective: "lambdarank" } }, BASE_HL)).toBe(
      "Ranked Trees",
    );
    expect(traitName({ learner: "gbdt", boosting: { objective: "runSize", maxDepth: 5 } }, BASE_HL)).toBe(
      "Runner Deep Trees",
    );
    expect(describeRecipe({ learner: "forest" }, BASE_HL)).toContain("Random forest of 60 trees");
    expect(plainSummary({ learner: "gbdt", boosting: { objective: "runSize" } })).toContain(
      "how big the run",
    );
    const ranker = normalizeRecipe({ learner: "gbdt", boosting: { objective: "lambdarank" } }, BASE_HL);
    expect(ranker.boosting?.objective).toBe("lambdarank");
    expect(ranker.boosting?.maxDepth).toBe(3);
    const rng = seededRng(5);
    for (let i = 0; i < 30; i++) {
      const child = mutateRecipe(ranker, rng, { baseHalfLifeDays: BASE_HL });
      if (child.learner === "gbdt") expect(child.boosting?.objective).toBe("lambdarank");
      const forest = mutateRecipe({ learner: "forest" }, rng, { baseHalfLifeDays: BASE_HL });
      expect(forest.learner).toBe("forest");
      expect(forest.forest?.trees).toBeGreaterThanOrEqual(30);
      expect(forest.forest?.maxDepth).toBeLessThanOrEqual(9);
    }
    expect(recipeFamily({ learner: "gbdt", boosting: { objective: "lambdarank" } })).toBe("gbdt:lambdarank");
    expect(recipeFamily({ learner: "gbdt" })).toBe("gbdt");
    expect(recipeFamily({ learner: "forest" })).toBe("forest");
  });

  it("guards a ranker's last seat like any other family's", () => {
    const now = new Date(t0.getTime() + 48 * 3_600_000);
    const lanes = [
      {
        lane: lane("rk", { learner: "gbdt", boosting: { objective: "lambdarank" } }),
        composite: 10,
        examScore: 20,
      },
      { lane: lane("t1", { learner: "gbdt" }), composite: 30, examScore: 20 },
      { lane: lane("t2", { learner: "gbdt" }), composite: 40, examScore: 20 },
    ];
    const base = { lanes, challengerScores: [50], now, minAgeMs: 0, margin: 3 };
    expect(chooseReplacement({ ...base, challengerLearners: ["gbdt"] })?.slot).toBe("t1");
    expect(chooseReplacement({ ...base, challengerLearners: ["gbdt:lambdarank"] })?.slot).toBe("rk");
  });
});
