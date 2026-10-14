import { describe, expect, it } from "vitest";
import {
  AGREEMENT_SIGNAL,
  agreementCount,
  CONSENSUS_MIN_BACKERS,
  consensusBacked,
  consensusBackersNeeded,
  stackedCalls,
  type StackedCuratorParams,
  quantileTable,
  rankFromQuantiles,
  scoreStacked,
  stackedFeatureNames,
  trainStackedCurator,
} from "./stacking.js";
import { syntheticMarket } from "./syntheticMarket.js";
import {
  confidenceRanks,
  CURATOR_MODEL_KIND,
  scoreCandidateWithModel,
  trainCurator,
  type TrainingRow,
} from "./trainer.js";

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
    // Without member cutoffs the agreement signal is flat and the member cutoffs are not stored -
    // and no member can back a call, so the member-backing gate leaves the exam empty.
    expect(params.meta.featureNames).toContain("agreement:share");
    expect(params.members.every((m) => m.callRank === undefined)).toBe(true);
    expect(stacked!.exam.calls).toBe(0);
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

  it("grades its meta exam with member cutoffs set on each chunk's training rows, not the stored ones", async () => {
    const rows = syntheticMarket({ tokens: 2000, days: 20, truth: "linear", seed: 9 }).sort(
      (a, b) => a.anchorAt.getTime() - b.anchorAt.getTime(),
    );
    const half = Math.floor(rows.length / 2);
    const model = await trainCurator(rows.slice(0, half));
    const reference: TrainingRow[] = rows.slice(half);
    const good = Float64Array.from(
      confidenceRanks(reference.map((r) => scoreCandidateWithModel(model, r.features))),
    );
    const other = Float64Array.from(reference, (_, i) => ((i * 7919) % reference.length) / reference.length);
    const run = (stored: number) =>
      trainStackedCurator(
        {
          reference,
          memberFoldRanks: new Map([
            ["a", good],
            ["b", other],
          ]),
          memberShippedProbabilities: new Map([
            ["a", good],
            ["b", other],
          ]),
          memberCallRanks: new Map([
            ["a", stored],
            ["b", stored],
          ]),
          heuristicMinScore: 55,
          targets,
          cooldownHours: 24,
          targetPerHour: 6,
        },
        1.01,
      );
    const loose = (await run(0.6))!;
    const strict = (await run(0.99))!;
    expect(loose.examChunks).toBeGreaterThan(0);
    expect(strict.exam).toEqual(loose.exam);
    expect(strict.outOfSample).toEqual(loose.outOfSample);
    // What ships still reads the stored cutoffs.
    expect(strict.params.members.map((m) => m.callRank)).toEqual([0.99, 0.99]);
  });
});

describe("the member-backing gate (user decision 2026-10-14)", () => {
  // Quantiles 0..0.99, so a member's probability is its rank; every member calls from rank 0.9.
  const quantiles = Array.from({ length: 100 }, (_, i) => i / 100);
  const member = (contestant: string, callRank?: number) => ({
    contestant,
    modelId: "",
    quantiles,
    ...(callRank !== undefined ? { callRank } : {}),
  });
  const params = (members: StackedCuratorParams["members"]): StackedCuratorParams => ({
    kind: "stacked-v1",
    members,
    rules: { quantiles: [], minScore: 55 },
    meta: { kind: CURATOR_MODEL_KIND, featureNames: [], means: [], stdevs: [], weights: [], bias: 0 },
    threshold: 0.5,
  });
  const probs = (entries: [string, number][]) => new Map(entries);

  it("needs three members calling at their own cutoffs, or every member of a smaller roster", () => {
    expect(CONSENSUS_MIN_BACKERS).toBe(3);
    expect(consensusBackersNeeded(10)).toBe(3);
    expect(consensusBackersNeeded(2)).toBe(2);
    const p = params(["a", "b", "c", "d"].map((c) => member(c, 0.9)));
    const two = probs([
      ["a", 0.95],
      ["b", 0.95],
      ["c", 0.5],
      ["d", 0.5],
    ]);
    const three = probs([
      ["a", 0.95],
      ["b", 0.95],
      ["c", 0.92],
      ["d", 0.5],
    ]);
    expect(consensusBacked(p.members, two)).toBe(false);
    expect(consensusBacked(p.members, three)).toBe(true);
    // A meta score over the line is not enough on its own (the Rules-backed, member-weak call)...
    expect(stackedCalls(p, 0.99, two)).toBe(false);
    // ...and backing is not enough below the line.
    expect(stackedCalls(p, 0.4, three)).toBe(false);
    expect(stackedCalls(p, 0.6, three)).toBe(true);
  });

  it("never counts a member without a cutoff or missing from the scores", () => {
    const p = params([member("a", 0.9), member("b", 0.9), member("c"), member("d", 0.9)]);
    expect(
      consensusBacked(
        p.members,
        probs([
          ["a", 0.95],
          ["b", 0.95],
          ["c", 0.99],
        ]),
      ),
    ).toBe(false);
    expect(
      consensusBacked(
        p.members,
        probs([
          ["a", 0.95],
          ["b", 0.95],
          ["d", 0.95],
        ]),
      ),
    ).toBe(true);
  });

  it("gates the meta exam's calls the same way, leaving the meta model's inputs as they are", async () => {
    const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 0 };
    const rows = syntheticMarket({ tokens: 2000, days: 20, truth: "linear", seed: 9 }).sort(
      (a, b) => a.anchorAt.getTime() - b.anchorAt.getTime(),
    );
    const half = Math.floor(rows.length / 2);
    const model = await trainCurator(rows.slice(0, half));
    const reference: TrainingRow[] = rows.slice(half);
    const good = Float64Array.from(
      confidenceRanks(reference.map((r) => scoreCandidateWithModel(model, r.features))),
    );
    const run = (thirdCutoff: number | null) =>
      trainStackedCurator(
        {
          reference,
          memberFoldRanks: new Map([
            ["a", good],
            ["b", good],
            ["c", good],
          ]),
          memberShippedProbabilities: new Map([
            ["a", good],
            ["b", good],
            ["c", good],
          ]),
          memberCallRanks: new Map([
            ["a", 0.8],
            ["b", 0.8],
            ["c", thirdCutoff],
          ]),
          heuristicMinScore: 55,
          targets,
          cooldownHours: 24,
          targetPerHour: 6,
        },
        1.01,
      );
    const backed = (await run(0.8))!;
    const unbacked = (await run(null))!;
    expect(backed.examChunks).toBeGreaterThan(0);
    // With three members able to call, the exam calls - and carries the 10x and run-size evidence
    // a single model's exam does, on the same scale.
    expect(backed.exam.graded).toBeGreaterThan(0);
    // Synthetic rows carry no 10x verdict, so only the losses settle the 10x tier.
    expect(backed.exam.tenXGraded).toBe(backed.exam.graded - backed.exam.wins);
    expect(backed.exam.sumRun).toBeGreaterThanOrEqual(backed.exam.sumLabel - 1e-9);
    // With only two members able to call, no moment has three backers: the exam calls nothing.
    expect(unbacked.exam.calls).toBe(0);
    // The meta model still reads every member's rank and Rules' two signals.
    expect(unbacked.params.meta.featureNames).toEqual(backed.params.meta.featureNames);
    expect(backed.params.meta.featureNames).toEqual(
      expect.arrayContaining(["a:rank", "b:rank", "c:rank", "rules:rank", "rules:gate", AGREEMENT_SIGNAL]),
    );
  });
});
