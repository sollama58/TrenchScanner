import { describe, expect, it } from "vitest";
import {
  CHAMPION_LOWER_BOUND_MIN_GRADED,
  championRules,
  pickChampion,
  resolveDefaultModel,
  showsBestModel,
  standingLowerBound,
  type ChampionStanding,
} from "./champion.js";

/** A seat whose live record over the window scores `score` on the full scorecard. */
function standing(id: string, score: number, graded: number, calling = true): ChampionStanding {
  const wins = Math.round((score * graded) / 100);
  return {
    id,
    name: id.toUpperCase(),
    calling,
    graded,
    wins,
    score,
    lowerBound: standingLowerBound({ wins, graded }),
  };
}

const rules = { minLiveGraded: 10, margin: 2 };

describe("pickChampion", () => {
  it("picks the best score among models with enough graded live calls", () => {
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
    expect(pick.reason).toContain("10 graded live alerts");
  });

  it("keeps the sitting champion unless a challenger's score leads by the margin", () => {
    const field = [standing("rules", 40, 400), standing("trees", 41.5, 400)];
    expect(pickChampion(field, "rules", rules, "consensus").id).toBe("rules");
    expect(pickChampion(field, null, rules, "consensus").id).toBe("trees");
    const clear = [standing("rules", 40, 400), standing("trees", 43, 400)];
    expect(pickChampion(clear, "rules", rules, "consensus").id).toBe("trees");
  });

  it("ranks on the score, not on volume", () => {
    const field = [standing("rules", 20, 2_000), standing("trees", 24, 300)];
    expect(pickChampion(field, null, rules, "consensus").id).toBe("trees");
  });

  it("drops a sitting champion that no longer qualifies", () => {
    const field = [standing("rules", 40, 40), standing("trees", 60, 2)];
    expect(pickChampion(field, "trees", rules, "consensus").id).toBe("rules");
  });
});

describe("pickChampion under the lower-bound rule (owner decision 2026-11-11)", () => {
  const lb = { minLiveGraded: 400, margin: 2, rule: "lower-bound" as const };

  it("ranks on the 2x lower bound, so a thin hot streak loses to a long steady record", () => {
    // 36% on 420 calls bounds at about 31.5%; 50% on 60 calls bounds at about 37.7% but is under the floor.
    const field = [standing("steady", 36, 420), standing("streak", 50, 60), standing("broad", 30, 2_000)];
    const pick = pickChampion(field, null, lb, "consensus");
    expect(pick).toMatchObject({ id: "steady", qualified: true });
    expect(pick.reason).toContain("2x lower bound");
    expect(pick.reason).toContain("7 days");
    expect(pick.reason).toContain("400 graded");
  });

  it("the bound penalises a small sample at the same rate", () => {
    const field = [standing("small", 30, 400), standing("large", 30, 4_000)];
    expect(pickChampion(field, null, lb, "consensus").id).toBe("large");
    expect(standingLowerBound({ wins: 120, graded: 400 })).toBeLessThan(
      standingLowerBound({ wins: 1_200, graded: 4_000 })!,
    );
    expect(standingLowerBound({ wins: 0, graded: 0 })).toBeNull();
  });

  it("keeps the sitting champion inside the margin, measured on the bound", () => {
    const field = [standing("sitting", 30, 1_000), standing("rival", 31, 1_000)];
    expect(pickChampion(field, "sitting", lb, "consensus").id).toBe("sitting");
    expect(pickChampion(field, null, lb, "consensus").id).toBe("rival");
  });

  it("falls back under the 400-call floor", () => {
    const pick = pickChampion([standing("trees", 40, 399)], null, lb, "consensus");
    expect(pick).toMatchObject({ id: "consensus", qualified: false });
  });

  it("is chosen by the env, with the score rule as the default, and hides the best badge", () => {
    const base = { CURATOR_CHAMPION_MIN_LIVE_GRADED: 50, CURATOR_CHAMPION_MARGIN: 3 };
    expect(championRules({ ...base, CURATOR_CHAMPION_RULE: "score" })).toEqual({
      rule: "score",
      minLiveGraded: 50,
      margin: 3,
    });
    expect(championRules({ ...base, CURATOR_CHAMPION_RULE: "lower-bound" })).toEqual({
      rule: "lower-bound",
      minLiveGraded: CHAMPION_LOWER_BOUND_MIN_GRADED,
      margin: 3,
    });
    expect(showsBestModel({ CURATOR_CHAMPION_RULE: "score" })).toBe(true);
    expect(showsBestModel({ CURATOR_CHAMPION_RULE: "lower-bound" })).toBe(false);
  });
});

describe("resolveDefaultModel", () => {
  it("uses the champion only while it can call", () => {
    expect(resolveDefaultModel("trees", () => true, "rules")).toBe("trees");
    expect(resolveDefaultModel("trees", () => false, "rules")).toBe("rules");
    expect(resolveDefaultModel(null, () => true, "rules")).toBe("rules");
  });
});
