import { describe, expect, it } from "vitest";
import { scoreTopSlice, topSliceCallers, topSliceRank, trainTopSliceCurator } from "./topSlice.js";
import { syntheticMarket } from "./syntheticMarket.js";
import { quantileTable } from "./stacking.js";

const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 0 };

describe("top slice rank", () => {
  it("is the top quarter of a member's call zone", () => {
    expect(topSliceRank(0.98)).toBeCloseTo(0.995, 10);
    expect(topSliceRank(0.8)).toBeCloseTo(0.95, 10);
  });
});

describe("scoreTopSlice", () => {
  const quantiles = quantileTable(Array.from({ length: 1000 }, (_, i) => i / 1000));
  const params = {
    kind: "top-slice-v1" as const,
    members: [
      { contestant: "trees", modelId: "", quantiles, callRank: 0.8, sliceRank: 0.95, sliceProbability: 0.95 },
      {
        contestant: "survivor",
        modelId: "",
        quantiles,
        callRank: 0.8,
        sliceRank: 0.95,
        sliceProbability: 0.95,
      },
    ],
  };
  const threshold = 1 / 3;

  it("calls only when a member is inside its slice, more members ranking higher", () => {
    const below = scoreTopSlice(
      params,
      new Map([
        ["trees", 0.9],
        ["survivor", 0.94],
      ]),
    );
    expect(below).toBeLessThan(threshold);
    const one = scoreTopSlice(
      params,
      new Map([
        ["trees", 0.999],
        ["survivor", 0.5],
      ]),
    );
    expect(one).toBeGreaterThanOrEqual(threshold);
    const both = scoreTopSlice(
      params,
      new Map([
        ["trees", 0.96],
        ["survivor", 0.96],
      ]),
    );
    expect(both).toBeGreaterThan(one);
    expect(both).toBeLessThan(1);
    expect(
      topSliceCallers(
        params,
        new Map([
          ["trees", 0.96],
          ["survivor", 0.99],
        ]),
      ),
    ).toEqual(["survivor", "trees"]);
  });

  it("treats a member that failed to load as not calling", () => {
    expect(scoreTopSlice(params, new Map([["survivor", 0.5]]))).toBe(0);
  });
});

describe("trainTopSliceCurator", () => {
  const reference = syntheticMarket({ tokens: 200, days: 5, truth: "linear", seed: 3 }).slice(0, 400);
  const n = reference.length;
  const ranks = Float64Array.from(reference, (_, i) => i / n);

  it("takes only tree seats with a cutoff, and nothing without one", () => {
    expect(
      trainTopSliceCurator({
        reference,
        memberFoldRanks: new Map([
          ["linear", ranks],
          ["trees", ranks],
        ]),
        memberShippedProbabilities: new Map([
          ["linear", ranks],
          ["trees", ranks],
        ]),
        memberCallRanks: new Map([
          ["linear", 0.8],
          ["trees", null],
        ]),
        targets,
        cooldownHours: 24,
      }),
    ).toBeNull();
  });

  it("grades the fixed rule on the members' fold ranks: the top quarter of the member's calls", () => {
    const result = trainTopSliceCurator({
      reference,
      memberFoldRanks: new Map([["trees", ranks]]),
      memberShippedProbabilities: new Map([["trees", ranks]]),
      memberCallRanks: new Map([["trees", 0.8]]),
      targets,
      cooldownHours: 0,
    })!;
    expect(result.params.members.map((m) => m.contestant)).toEqual(["trees"]);
    expect(result.params.members[0]!.sliceRank).toBeCloseTo(0.95, 10);
    expect(result.params.threshold).toBe(0.5);
    // Ranks i/n: the rows at or above rank 0.95 are the top 5% of 400.
    expect(result.exam.calls).toBe(20);
    expect(result.precisionCalibration.support).toBe(20);
    // At serve time the shipped probability that marks the slice is the one at rank 0.95.
    expect(result.params.members[0]!.sliceProbability).toBeCloseTo(0.95, 2);
  });
});
