import { describe, expect, it } from "vitest";
import { pickChampion, resolveDefaultModel, type ChampionStanding } from "./champion.js";

/** A seat that doubled `ratePct` of `graded` calls in the window. */
function standing(id: string, ratePct: number, graded: number, calling = true): ChampionStanding {
  return { id, name: id.toUpperCase(), calling, graded, wins: Math.round((ratePct * graded) / 100) };
}

const rules = { minLiveGraded: 10, margin: 2 };

describe("pickChampion", () => {
  it("picks the best 2x lower bound among models with enough graded live calls", () => {
    const pick = pickChampion(
      [standing("rules", 30, 40), standing("trees", 55, 12), standing("lucky", 90, 3)],
      null,
      rules,
      "consensus",
    );
    expect(pick).toMatchObject({ id: "trees", qualified: true });
  });

  it("skips models that can't call", () => {
    const pick = pickChampion(
      [standing("rules", 30, 40), standing("trees", 55, 12, false)],
      null,
      rules,
      "consensus",
    );
    expect(pick.id).toBe("rules");
  });

  it("falls back when nothing qualifies", () => {
    const pick = pickChampion([standing("trees", 55, 4), standing("rules", 0, 0)], null, rules, "consensus");
    expect(pick).toMatchObject({ id: "consensus", qualified: false });
    expect(pick.reason).toContain("10 graded live calls");
  });

  it("keeps the sitting champion unless a challenger's lower bound leads by the margin", () => {
    // Lower bounds at 400 calls: 40% -> 35.3, 41.5% -> 36.8 (1.5 points), 43% -> 38.2 (2.9).
    const field = [standing("rules", 40, 400), standing("trees", 41.5, 400)];
    expect(pickChampion(field, "rules", rules, "consensus").id).toBe("rules");
    expect(pickChampion(field, null, rules, "consensus").id).toBe("trees");
    const clear = [standing("rules", 40, 400), standing("trees", 43, 400)];
    expect(pickChampion(clear, "rules", rules, "consensus").id).toBe("trees");
  });

  it("ranks on the 2x rate, not on volume", () => {
    // A seat calling half the market at 20% loses to a tighter one at 24% (lower bounds 18.3 vs 19.5).
    const field = [standing("rules", 20, 2_000), standing("trees", 24, 300)];
    expect(pickChampion(field, null, rules, "consensus").id).toBe("trees");
  });

  it("drops a sitting champion that no longer qualifies", () => {
    const field = [standing("rules", 40, 40), standing("trees", 60, 2)];
    expect(pickChampion(field, "trees", rules, "consensus").id).toBe("rules");
  });
});

describe("resolveDefaultModel", () => {
  it("uses the champion only while it can call", () => {
    expect(resolveDefaultModel("trees", () => true, "rules")).toBe("trees");
    expect(resolveDefaultModel("trees", () => false, "rules")).toBe("rules");
    expect(resolveDefaultModel(null, () => true, "rules")).toBe("rules");
  });
});
