import { describe, expect, it } from "vitest";
import {
  AGREEMENT_SIGNAL,
  agreementCount,
  quantileTable,
  rankFromQuantiles,
  scoreStacked,
  stackedFeatureNames,
  trainStackedCurator,
} from "./stacking.js";
import { syntheticMarket } from "./syntheticMarket.js";
import { confidenceRanks, scoreCandidateWithModel, trainCurator, type TrainingRow } from "./trainer.js";

describe("quantile ranks", () => {
  it("matches the confidenceRanks convention on the full table", () => {
    const values = [0.1, 0.4, 0.4, 0.9, 0.2];
    const table = quantileTable(values);
    const exact = confidenceRanks(values);
    values.forEach((v, i) => expect(rankFromQuantiles(table, v)).toBeCloseTo(exact[i]!, 10));
  });

  it("downsamples to at most the requested points, keeping both ends", () => {
    const values = Array.from({ length: 10_000 }, (_, i) => i);
    const table = quantileTable(values, 200);
    expect(table).toHaveLength(200);
    expect(table[0]).toBe(0);
    expect(table[199]).toBe(9_999);
    expect(rankFromQuantiles(table, 5_000)).toBeCloseTo(0.5, 1);
  });
});

describe("trainStackedCurator", () => {
  const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 0 };

  it("needs at least two members", async () => {
    const reference = syntheticMarket({ tokens: 50, days: 5, truth: "linear", seed: 1 }).slice(0, 10);
    const ranks = new Float64Array(reference.length);
    const stacked = await trainStackedCurator(
      {
        reference,
        memberFoldRanks: new Map([["a", ranks]]),
        memberShippedProbabilities: new Map([["a", ranks]]),
        heuristicMinScore: 55,
        targets,
        cooldownHours: 24,
        targetPerHour: 6,
      },
      1.01,
    );
    expect(stacked).toBeNull();
  });

  it("learns to trust the informative member over the noise member", async () => {
    const rows = syntheticMarket({ tokens: 3000, days: 30, truth: "linear", seed: 5 }).sort(
      (a, b) => a.anchorAt.getTime() - b.anchorAt.getTime(),
    );
    const half = Math.floor(rows.length / 2);
    const model = await trainCurator(rows.slice(0, half));
    const reference: TrainingRow[] = rows.slice(half);
    const informative = confidenceRanks(reference.map((r) => scoreCandidateWithModel(model, r.features)));
    let seed = 7;
    const noise = reference.map(() => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    });

    const stacked = await trainStackedCurator(
      {
        reference,
        memberFoldRanks: new Map([
          ["good", Float64Array.from(informative)],
          ["noise", Float64Array.from(noise)],
        ]),
        memberShippedProbabilities: new Map([
          ["good", Float64Array.from(informative)],
          ["noise", Float64Array.from(noise)],
        ]),
        heuristicMinScore: 55,
        targets,
        cooldownHours: 24,
        targetPerHour: 6,
      },
      1.01,
    );
    expect(stacked).not.toBeNull();
    const { params } = stacked!;
    expect(params.meta.featureNames).toEqual(stackedFeatureNames(params.members));
    const weight = (name: string) => params.meta.weights[params.meta.featureNames.indexOf(name)]!;
    expect(weight("good:rank")).toBeGreaterThan(Math.abs(weight("noise:rank")) * 3);

    // At serve time a top-ranked "good" member pushes the consensus up; the noise member barely moves it.
    const rules = { gate: false, rankScore: 0 };
    const high = scoreStacked(
      params,
      new Map([
        ["good", 1],
        ["noise", 0.5],
      ]),
      rules,
    );
    const low = scoreStacked(
      params,
      new Map([
        ["good", 0],
        ["noise", 0.5],
      ]),
      rules,
    );
    expect(high).toBeGreaterThan(low);
    expect(stacked!.examChunks).toBeGreaterThan(0);
    // Without member cutoffs the agreement signal is flat and the member cutoffs are not stored.
    expect(params.meta.featureNames).toContain("agreement:share");
    expect(params.members.every((m) => m.callRank === undefined)).toBe(true);
  });

  it("stores each member's cutoff and reads how many members call at serve time", async () => {
    const rows = syntheticMarket({ tokens: 2000, days: 20, truth: "linear", seed: 9 }).sort(
      (a, b) => a.anchorAt.getTime() - b.anchorAt.getTime(),
    );
    const half = Math.floor(rows.length / 2);
    const model = await trainCurator(rows.slice(0, half));
    const reference: TrainingRow[] = rows.slice(half);
    const ranks = Float64Array.from(
      confidenceRanks(reference.map((r) => scoreCandidateWithModel(model, r.features))),
    );
    const stacked = await trainStackedCurator(
      {
        reference,
        memberFoldRanks: new Map([
          ["a", ranks],
          ["b", ranks],
        ]),
        memberShippedProbabilities: new Map([
          ["a", ranks],
          ["b", ranks],
        ]),
        memberCallRanks: new Map([
          ["a", 0.9],
          ["b", null],
        ]),
        heuristicMinScore: 55,
        targets,
        cooldownHours: 24,
        targetPerHour: 6,
      },
      1.01,
    );
    expect(stacked).not.toBeNull();
    const { params } = stacked!;
    expect(params.members.map((m) => m.callRank)).toEqual([0.9, undefined]);
    expect(agreementCount(params.members, [0.95, 0.95])).toBe(1);
    expect(agreementCount(params.members, [0.5, 0.95])).toBe(0);
    expect(stackedFeatureNames(params.members)).toContain(AGREEMENT_SIGNAL);
  });
});
