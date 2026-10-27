import { describe, expect, it } from "vitest";
import {
  chooseCombinerMembers,
  memberCandidate,
  memberFamily,
  type MemberCandidate,
} from "./combinerMembers.js";
import { MOMENTUM_FEATURES, ORDER_FLOW_FEATURES, type ContestantSpec } from "./contestants.js";

const cand = (
  contestant: string,
  recipe: MemberCandidate["recipe"],
  examScore: number | null,
  examWinRate: number | null = 0.25,
  standalone = false,
): MemberCandidate => ({ contestant, recipe, standalone, examScore, examWinRate });

describe("memberFamily", () => {
  it("groups tree recipes of any depth or memory together, and tells the formula seats apart", () => {
    expect(memberFamily({ learner: "gbdt", goal: "return" })).toBe(
      memberFamily({ learner: "gbdt", boosting: { maxDepth: 5 }, recencyHalfLifeDays: 3, goal: "return" }),
    );
    expect(memberFamily({ learner: "gbdt", twoStage: true })).not.toBe(memberFamily({ learner: "gbdt" }));
    expect(memberFamily({ learner: "gbdt", boosting: { objective: "runSize" } })).not.toBe(
      memberFamily({ learner: "gbdt" }),
    );
    expect(memberFamily({ learner: "forest" })).not.toBe(memberFamily({ learner: "gbdt" }));
    const formula = memberFamily({ learner: "logistic" });
    expect(memberFamily({ learner: "logistic", featureNames: ORDER_FLOW_FEATURES })).not.toBe(formula);
    expect(memberFamily({ learner: "logistic", featureNames: MOMENTUM_FEATURES })).not.toBe(formula);
    expect(memberFamily({ learner: "logistic", featureNames: MOMENTUM_FEATURES })).not.toBe(
      memberFamily({ learner: "logistic", featureNames: ORDER_FLOW_FEATURES }),
    );
  });
});

describe("chooseCombinerMembers", () => {
  const trees = { learner: "gbdt" as const, goal: "return" as const };

  it("keeps one lane per family, the one with the best exam, and says why the rest sit out", () => {
    const choice = chooseCombinerMembers(
      [
        cand("trees", trees, 30),
        cand("linear", { ...trees, boosting: { maxDepth: 5 } }, 34), // evolution handed it a tree recipe
        cand("forest", { learner: "forest" }, 20),
        cand("survivor", { learner: "gbdt", twoStage: true }, null),
        cand("order-flow", { learner: "logistic", featureNames: ORDER_FLOW_FEATURES }, 10),
      ],
      0.15,
    );
    expect(choice.members).toEqual(["linear", "forest", "survivor", "order-flow"]);
    expect(choice.leftOut).toEqual([
      { contestant: "trees", reason: "same family as linear (gbdt) with a lower exam score" },
    ]);
  });

  it("drops a seat whose exam 2x rate is under 1.2x the rows' own, unless no rows are known", () => {
    const weak = [
      cand("trees", trees, 30, 0.25),
      cand("order-flow", { learner: "logistic", featureNames: ORDER_FLOW_FEATURES }, 10, 0.17),
    ];
    const choice = chooseCombinerMembers(weak, 0.15);
    expect(choice.members).toEqual(["trees"]);
    expect(choice.leftOut[0]!.reason).toBe("exam 2x 17.0% is under 1.2x the rows' 15.0%");
    expect(chooseCombinerMembers(weak, 0).members).toEqual(["trees", "order-flow"]);
    // A seat whose exam graded nothing has no rate to judge; the family rule still applies to it.
    expect(chooseCombinerMembers([cand("trees", trees, 30, null)], 0.15).members).toEqual(["trees"]);
  });

  it("admits a standalone seat only as its family's sole representative", () => {
    const sharp = cand("sharp-trees", { ...trees, cutoffShare: 0.1 }, 50, 0.3, true);
    const catcher = cand("catcher", { learner: "gbdt", goal: "catch" }, 40, 0.22, true);
    const sharpSurvivor = cand(
      "sharp-survivor",
      { learner: "gbdt", twoStage: true, cutoffShare: 0.1 },
      45,
      0.3,
      true,
    );
    const withLane = chooseCombinerMembers([cand("trees", trees, 20), sharp, catcher, sharpSurvivor], 0.15);
    // Sharp outscores Trees on its own tighter exam, but a lane holds the family.
    expect(withLane.members).toEqual(["trees", "sharp-survivor"]);
    expect(withLane.leftOut.map((l) => l.contestant)).toEqual(["sharp-trees", "catcher"]);
    expect(withLane.leftOut[0]!.reason).toBe("standalone seat in trees's family (gbdt)");
    const noLane = chooseCombinerMembers([sharp, catcher], 0.15);
    expect(noLane.members).toEqual(["sharp-trees"]);
  });

  it("builds a candidate from a spec and its exam record", () => {
    const spec = {
      id: "trees",
      name: "Trees",
      description: "",
      role: "learner",
      recipe: trees,
    } as ContestantSpec;
    expect(memberCandidate(spec, trees, { examScore: 12, wins: 30, graded: 120 })).toEqual({
      contestant: "trees",
      recipe: trees,
      standalone: false,
      examScore: 12,
      examWinRate: 0.25,
    });
    expect(
      memberCandidate({ ...spec, control: true }, trees, { examScore: null, wins: 0, graded: 0 }),
    ).toMatchObject({
      standalone: true,
      examWinRate: null,
    });
  });
});
