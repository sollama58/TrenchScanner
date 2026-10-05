import { describe, expect, it } from "vitest";
import { pickChampion, resolveDefaultModel, type ChampionStanding } from "./champion.js";
import { scoreBand, type CompositeScore } from "./leaderboard.js";

function standing(id: string, score: number | null, liveGraded: number, calling = true): ChampionStanding {
  const summary = {
    calls: liveGraded,
    graded: liveGraded,
    winRatePct: null,
    goalRatePct: null,
    proven2xPct: null,
    proven4xPct: null,
    avgReturnDoublings: null,
    avgRunDoublings: null,
    provenRunDoublings: null,
    simCalls: 0,
    avgSimReturnPct: null,
    totalSimReturnPct: null,
    score,
  };
  const composite: CompositeScore = {
    score,
    band: scoreBand(score),
    liveWeight: 0.5,
    warmingUp: liveGraded < 50,
    basis: null,
    live: summary,
    exam: summary,
  };
  return { id, name: id.toUpperCase(), calling, composite };
}

const rules = { minLiveGraded: 10, margin: 2 };

describe("pickChampion", () => {
  it("picks the top score among models with enough graded live calls", () => {
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
    const pick = pickChampion(
      [standing("trees", 55, 4), standing("rules", null, 0)],
      null,
      rules,
      "consensus",
    );
    expect(pick).toMatchObject({ id: "consensus", qualified: false });
    expect(pick.reason).toContain("10 graded live calls");
  });

  it("keeps the sitting champion unless a challenger leads by the margin", () => {
    const field = [standing("rules", 40, 40), standing("trees", 41.5, 20)];
    expect(pickChampion(field, "rules", rules, "consensus").id).toBe("rules");
    expect(pickChampion(field, null, rules, "consensus").id).toBe("trees");
    const clear = [standing("rules", 40, 40), standing("trees", 42.5, 20)];
    expect(pickChampion(clear, "rules", rules, "consensus").id).toBe("trees");
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
