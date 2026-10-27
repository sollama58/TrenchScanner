import { describe, expect, it } from "vitest";
import { agreeingFromScore, agreementScore, scoreAgreement, trainAgreementCurator } from "./agreement.js";
import { syntheticMarket } from "./syntheticMarket.js";
import { confidenceRanks, scoreCandidateWithModel, trainCurator, type TrainingRow } from "./trainer.js";
import { quantileTable } from "./stacking.js";

describe("agreement score", () => {
  it("puts every token with more callers above any token with fewer, ties broken by mean rank", () => {
    const two = agreementScore(2, [0.99, 0.98, 0.1], 3);
    const one = agreementScore(1, [0.999, 0.2, 0.1], 3);
    const alsoTwo = agreementScore(2, [0.95, 0.9, 0.5], 3);
    expect(two).toBeGreaterThan(one);
    expect(alsoTwo).toBeGreaterThan(one);
    expect(two).toBeLessThan(1);
    expect(agreeingFromScore(two, 3)).toBe(2);
    expect(agreeingFromScore(alsoTwo, 3)).toBe(2);
    expect(agreeingFromScore(one, 3)).toBe(1);
    expect(agreeingFromScore(agreementScore(3, [1, 1, 1], 3), 3)).toBe(3);
  });

  it("counts a member as calling only when it has a cutoff and clears it", () => {
    const quantiles = quantileTable(Array.from({ length: 100 }, (_, i) => i / 100));
    const params = {
      kind: "agreement-v1" as const,
      members: [
        { contestant: "a", modelId: "", quantiles, callRank: 0.9 },
        { contestant: "b", modelId: "", quantiles, callRank: 0.9 },
        { contestant: "c", modelId: "", quantiles }, // exam set no cutoff: never calls
      ],
    };
    const probabilities = new Map([
      ["a", 0.95],
      ["b", 0.95],
      ["c", 0.99],
    ]);
    expect(agreeingFromScore(scoreAgreement(params, probabilities), 3)).toBe(2);
    probabilities.set("b", 0.5);
    expect(agreeingFromScore(scoreAgreement(params, probabilities), 3)).toBe(1);
    // A member that failed to load ranks at the bottom and cannot call.
    probabilities.delete("a");
    expect(agreeingFromScore(scoreAgreement(params, probabilities), 3)).toBe(0);
  });
});

describe("trainAgreementCurator", () => {
  const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 0 };

  it("needs at least two members", () => {
    const reference = syntheticMarket({ tokens: 50, days: 5, truth: "linear", seed: 1 }).slice(0, 10);
    const ranks = new Float64Array(reference.length);
    expect(
      trainAgreementCurator(
        {
          reference,
          memberFoldRanks: new Map([["a", ranks]]),
          memberShippedProbabilities: new Map([["a", ranks]]),
          memberCallRanks: new Map([["a", 0.9]]),
          targets,
          cooldownHours: 24,
          targetPerHour: 6,
        },
        1.01,
      ),
    ).toBeNull();
  });

  it("ships member cutoffs, a curve by callers and an exam graded across chunks", async () => {
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
    const result = trainAgreementCurator(
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
        memberCallRanks: new Map([
          ["good", 0.95],
          ["noise", null],
        ]),
        targets,
        cooldownHours: 24,
        targetPerHour: 6,
      },
      1.01,
    );
    expect(result).not.toBeNull();
    const { params, curve } = result!;
    expect(params.kind).toBe("agreement-v1");
    expect(params.members.map((m) => m.callRank)).toEqual([0.95, undefined]);
    // The noise member never calls, so no row has two callers; the informative member's calls win more.
    expect(curve.map((p) => p.agreeing)).toEqual([0, 1, 2]);
    expect(curve[2]!.rows).toBe(0);
    expect(curve[0]!.rows + curve[1]!.rows).toBe(reference.length);
    expect(curve[1]!.rows).toBeGreaterThan(0);
    expect(curve[1]!.wins / curve[1]!.rows).toBeGreaterThan(curve[0]!.wins / curve[0]!.rows);
    expect(result!.examChunks).toBeGreaterThan(0);
    // Synthetic rows carry no 10x verdict, so only the losses settle the 10x tier.
    expect(result!.exam.tenXGraded).toBe(result!.exam.graded - result!.exam.wins);
    expect(result!.exam.sumRun).toBeGreaterThanOrEqual(result!.exam.sumLabel - 1e-9);
    expect(result!.outOfSample).toHaveLength(reference.length);
    for (const c of result!.outOfSample) expect(c.probability).toBeLessThan(1);
    // The calibration's evidence: the same rows, scored at member cutoffs set off their chunk.
    expect(result!.heldOut).toHaveLength(reference.length);
    expect(result!.heldOut.map((c) => c.labelValue)).toEqual(result!.outOfSample.map((c) => c.labelValue));
    expect(result!.heldOut.some((c, i) => c.probability !== result!.outOfSample[i]!.probability)).toBe(true);
  });

  it("grades its exam with member cutoffs set on the other chunks, not the stored in-sample ones", () => {
    const reference = syntheticMarket({ tokens: 300, days: 3, truth: "linear", seed: 5 })
      .slice(0, 900)
      .sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
    const a = Float64Array.from(reference, (_, i) => ((i * 7919) % reference.length) / reference.length);
    const b = Float64Array.from(reference, (_, i) => ((i * 104729) % reference.length) / reference.length);
    const exam = (stored: number) =>
      trainAgreementCurator(
        {
          reference,
          memberFoldRanks: new Map([
            ["a", a],
            ["b", b],
          ]),
          memberShippedProbabilities: new Map([
            ["a", a],
            ["b", b],
          ]),
          memberCallRanks: new Map([
            ["a", stored],
            ["b", stored],
          ]),
          targets,
          cooldownHours: 0,
          targetPerHour: 0,
        },
        1.01,
      )!.exam;
    expect(exam(0.6).graded).toBeGreaterThan(0);
    expect(exam(0.99)).toEqual(exam(0.6));
  });
});

describe("agreement floor", () => {
  it("is the score at which at least 70% of the members call, rounded up", async () => {
    const { agreementFloor, withAgreementFloor } = await import("./agreement.js");
    expect(agreementFloor(10)).toBeCloseTo(7 / 11);
    expect(agreementFloor(5)).toBeCloseTo(4 / 6);
    expect(agreementFloor(3)).toBeCloseTo(3 / 4);
    expect(agreementFloor(0)).toBe(0);
    // Scores at the floor count as calling, and the mean rank never lifts a count over the floor.
    expect(agreementScore(7, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10)).toBeGreaterThanOrEqual(agreementFloor(10));
    expect(agreementScore(6, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 10)).toBeLessThan(agreementFloor(10));

    const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 2 };
    const outOfSample = [
      { probability: agreementScore(8, [0.9], 10), labelValue: 1 },
      { probability: agreementScore(7, [0.9], 10), labelValue: 0 },
      { probability: agreementScore(5, [0.9], 10), labelValue: 1 },
      { probability: agreementScore(4, [0.9], 10), labelValue: 0 },
    ];
    const low = { threshold: agreementScore(4, [0.9], 10), support: 4, winRatePct: 50, goalRatePct: 0 };
    const raised = withAgreementFloor(low, outOfSample, 10, targets);
    expect(raised.threshold).toBeCloseTo(7 / 11);
    expect(raised.support).toBe(2);
    expect(raised.winRatePct).toBe(50);
    expect(raised.meetsTargets).toBe(false);
    // A cutoff already above the floor, or no cutoff at all, is left alone.
    const high = { ...low, threshold: agreementScore(9, [0.9], 10) };
    expect(withAgreementFloor(high, outOfSample, 10, targets)).toBe(high);
    const none = { ...low, threshold: null };
    expect(withAgreementFloor(none, outOfSample, 10, targets)).toBe(none);
  });
});
