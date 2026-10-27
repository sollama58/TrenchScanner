// Split out of contest.test.ts: each of these trains a field of seats, and a file runs its tests
// one after another, so they get files of their own to train side by side with the rest.
import { describe, expect, it } from "vitest";
import {
  HIGH_PRECISION_CUTOFF_SHARE,
  ORDER_FLOW_FEATURES,
  PROFIT_FACTOR_CONTESTANT,
  SHARP_AGREEMENT_CONTESTANT,
  SHARP_AGREEMENT_MEMBERS,
  SHARP_SURVIVOR_CONTESTANT,
  SHARP_TREES_CONTESTANT,
  TREES_NO_TOKENSAGE_CONTESTANT,
  contestantSpec,
  enabledContestants,
  type ContestantSpec,
} from "./contestants.js";
import { NEVER_EMIT_THRESHOLD, runContestTraining } from "./trainingRun.js";
import { syntheticMarket } from "./syntheticMarket.js";
import type { StackedCuratorParams } from "./stacking.js";
import { AGREEMENT_MODEL_KIND, agreementFloor, type AgreementCuratorParams } from "./agreement.js";

describe("runContestTraining", () => {
  it("ships one model per contestant and stacks the consensus on the learners", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const results = await runContestTraining(rows, {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["consensus", "linear", "order-flow", "trees"]),
    });
    expect(results.map((r) => r.contestant)).toEqual(["consensus", "rules", "linear", "order-flow", "trees"]);
    for (const r of results) {
      expect(r.metrics.contestant).toBe(r.contestant);
      expect(r.metrics.exam).toBeDefined();
    }
    const orderFlow = results.find((r) => r.contestant === "order-flow")!.params as {
      featureNames: string[];
    };
    expect(orderFlow.featureNames).toEqual([...ORDER_FLOW_FEATURES]);
    const consensus = results.find((r) => r.contestant === "consensus")!.params as StackedCuratorParams;
    // The voting combiners count one seat per recipe family, none whose exam barely beats the
    // rows' own 2x rate (combinerMembers.ts): on this market Order Flow's exam falls under that
    // floor, and the verdict says so.
    expect(consensus.members.map((m) => m.contestant)).toEqual(["linear", "trees"]);
    expect(consensus.members.every((m) => m.quantiles.length > 0)).toBe(true);
    const consensusVerdict = results.find((r) => r.contestant === "consensus")!.metrics.verdict.reason;
    expect(consensusVerdict).toContain("members linear, trees; left out order-flow (exam 2x ");
    expect(consensusVerdict).toContain("is under 1.2x the rows'");
    // Trader keeps stacking every learner.
    const trader = results.find((r) => r.contestant === "trader");
    if (trader)
      expect((trader.params as StackedCuratorParams).members.map((m) => m.contestant)).toEqual([
        "linear",
        "order-flow",
        "trees",
      ]);
  }, 60_000);

  it("ships a control seat on its own ledger without stacking it into the combiners", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const results = await runContestTraining(rows, {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      // Simple Trees is retired (2026-10-18), so the roster leaves it out; its spec still
      // exercises the control path.
      contestants: [
        ...enabledContestants(["consensus", "blend", "linear", "trees"]),
        contestantSpec(TREES_NO_TOKENSAGE_CONTESTANT)!,
      ],
    });
    const control = results.find((r) => r.contestant === TREES_NO_TOKENSAGE_CONTESTANT)!;
    expect(control.metrics.exam).toBeDefined();
    for (const id of ["consensus", "blend"]) {
      const combiner = results.find((r) => r.contestant === id)!.params as StackedCuratorParams;
      expect(combiner.members.map((m) => m.contestant)).toEqual(["linear", "trees"]);
    }
  }, 60_000);
});

describe("a high-precision seat in the contest", () => {
  it("calls a narrower slice than the field and is stacked by no combiner", async () => {
    const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
    const results = await runContestTraining(rows, {
      // The field's rule as production runs it: anchored on the top third of moments.
      targets: {
        winRate: 0.75,
        goalRate: 0.5,
        minSupport: 30,
        confidenceZ: 1,
        targetShare: 0.33,
        shareBand: 0.1,
        shareHurdle: 0.01,
      },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["consensus", "linear", "trees", SHARP_TREES_CONTESTANT]).map((c) =>
        c.id === SHARP_TREES_CONTESTANT
          ? { ...c, recipe: { learner: "gbdt" as const, cutoffShare: HIGH_PRECISION_CUTOFF_SHARE } }
          : c,
      ),
    });
    const trees = results.find((r) => r.contestant === "trees")!;
    const sharp = results.find((r) => r.contestant === SHARP_TREES_CONTESTANT)!;
    expect(sharp.metrics.exam!.calls).toBeGreaterThan(0);
    expect(sharp.metrics.precisionCalibration!.support).toBeLessThan(
      trees.metrics.precisionCalibration!.support,
    );
    const consensus = results.find((r) => r.contestant === "consensus")!.params as StackedCuratorParams;
    expect(consensus.members.map((m) => m.contestant)).toEqual(["linear", "trees"]);
  }, 60_000);
});

describe("the Sharp Agreement seat (model audit 2026-10-26, §15)", () => {
  const cfg = {
    targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
    targetPerHour: 6,
    heuristicMinScore: 55,
    minRowsToPromote: 1500,
    recencyHalfLifeDays: 14,
    cooldownHours: 24,
    heuristicPrecisionGate: true,
  };
  // The Sharp seats on a light recipe each: the test is about who the seat counts, not the trees.
  const light = (c: ContestantSpec): ContestantSpec =>
    SHARP_AGREEMENT_MEMBERS.includes(c.id)
      ? { ...c, recipe: { learner: "gbdt" as const, cutoffShare: HIGH_PRECISION_CUTOFF_SHARE } }
      : c;

  it("counts the three Sharp seats from Trader's maps, tracking only, beside the room's Agreement", async () => {
    const rows = syntheticMarket({ tokens: 2000, days: 30, truth: "interactions", seed: 17 });
    const results = await runContestTraining(rows, {
      ...cfg,
      contestants: enabledContestants([
        "consensus",
        "agreement",
        SHARP_AGREEMENT_CONTESTANT,
        "linear",
        "trees",
        ...SHARP_AGREEMENT_MEMBERS,
      ]).map(light),
    });
    const byId = new Map(results.map((r) => [r.contestant, r]));
    // Roster order, the combiners first; the seat ships like any agreement seat.
    expect(results.map((r) => r.contestant).slice(0, 3)).toEqual([
      "consensus",
      "agreement",
      SHARP_AGREEMENT_CONTESTANT,
    ]);
    const sharp = byId.get(SHARP_AGREEMENT_CONTESTANT)!;
    const params = sharp.params as AgreementCuratorParams;
    expect(params.kind).toBe(AGREEMENT_MODEL_KIND);
    expect(params.members.map((m) => m.contestant)).toEqual([
      SHARP_TREES_CONTESTANT,
      SHARP_SURVIVOR_CONTESTANT,
      PROFIT_FACTOR_CONTESTANT,
    ]);
    // Each member counts at the cutoff its own exam set.
    for (const m of params.members) {
      expect(m.callRank).toBe(byId.get(m.contestant)!.metrics.precisionCalibration.threshold ?? undefined);
      expect(m.quantiles.length).toBeGreaterThan(0);
    }
    // The agreement floor applies as usual: with three members, all three must call.
    if (params.threshold < NEVER_EMIT_THRESHOLD)
      expect(params.threshold).toBeGreaterThanOrEqual(agreementFloor(3));
    expect(sharp.metrics.exam).toBeDefined();
    expect(sharp.metrics.agreementCurve!.map((p) => p.agreeing)).toEqual([0, 1, 2, 3]);
    expect(sharp.metrics.verdict.reason).toContain(`Sharp Agreement: 3 models' alerts counted`);
    expect(sharp.metrics.verdict.reason).toContain(
      `members ${SHARP_TREES_CONTESTANT}, ${SHARP_SURVIVOR_CONTESTANT}, ${PROFIT_FACTOR_CONTESTANT}`,
    );
    expect(sharp.metrics.verdict.reason).not.toContain("without");
    // The room's Agreement keeps its own, chosen members; the seat is tracking only on the roster.
    const room = byId.get("agreement")!.params as AgreementCuratorParams;
    expect(room.members.map((m) => m.contestant)).not.toEqual(params.members.map((m) => m.contestant));
    expect(contestantSpec(SHARP_AGREEMENT_CONTESTANT)!.trackingOnly).toBe(true);
  }, 180_000);

  it("ships on two Sharp seats, naming the one without an exam, and not on one", async () => {
    const rows = syntheticMarket({ tokens: 2000, days: 30, truth: "interactions", seed: 17 });
    const two = await runContestTraining(rows, {
      ...cfg,
      // Two member learners keep the combiners on the roster (enabledContestants).
      contestants: enabledContestants([
        SHARP_AGREEMENT_CONTESTANT,
        "linear",
        "trees",
        SHARP_TREES_CONTESTANT,
        PROFIT_FACTOR_CONTESTANT,
      ]).map(light),
    });
    const sharp = two.find((r) => r.contestant === SHARP_AGREEMENT_CONTESTANT)!;
    expect((sharp.params as AgreementCuratorParams).members.map((m) => m.contestant)).toEqual([
      SHARP_TREES_CONTESTANT,
      PROFIT_FACTOR_CONTESTANT,
    ]);
    expect(sharp.metrics.verdict.reason).toContain(`without ${SHARP_SURVIVOR_CONTESTANT} (no exam this run)`);

    const one = await runContestTraining(rows, {
      ...cfg,
      contestants: enabledContestants([
        SHARP_AGREEMENT_CONTESTANT,
        "linear",
        "trees",
        SHARP_TREES_CONTESTANT,
      ]).map(light),
    });
    expect(one.map((r) => r.contestant)).toEqual(["rules", "linear", "trees", SHARP_TREES_CONTESTANT]);
  }, 180_000);
});
