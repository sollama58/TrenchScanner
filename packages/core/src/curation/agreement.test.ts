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
