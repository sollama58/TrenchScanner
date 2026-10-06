import { describe, expect, it } from "vitest";
import {
  describeCondition,
  describeRuleSet,
  distillRuleSet,
  examineRuleScores,
  ruleSetReasons,
  scoreRuleSet,
  teacherAgreementPct,
  type DerivedRuleSet,
} from "./rulesDistill.js";
import { enabledContestants } from "./contestants.js";
import { runEvolvingContest, type ContestTrainingConfig, type RulesCuratorParams } from "./trainingRun.js";
import { syntheticMarket } from "./syntheticMarket.js";
import type { EvalFold, TrainingRow } from "./trainer.js";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Rows whose teacher cares about 5m buys most, fresh wallets a little, and nothing else. */
function teacherWorld(n: number) {
  const rand = prng(7);
  const rows: TrainingRow[] = [];
  const teacher: number[] = [];
  for (let i = 0; i < n; i++) {
    const buys5m = Math.floor(rand() * 100);
    const fresh = Math.floor(rand() * 60);
    const noise = rand();
    rows.push({
      anchorAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000),
      features: { buys5m, freshTop10WalletPct: fresh, mcapUsd: 20_000 + noise * 50_000, ctxHourSin: noise },
      labelValue: buys5m > 70 && fresh < 20 ? 1 : 0,
      anchorPriceUsd: 1,
      anchorMcapUsd: 20_000,
      tokenId: `t${i}`,
    });
    teacher.push(0.8 * (buys5m / 100) + 0.2 * (1 - fresh / 60));
  }
  // The teacher's ranks: share of rows it scored lower.
  const sorted = [...teacher].sort((a, b) => a - b);
  const ranks = teacher.map((t) => sorted.findIndex((s) => s >= t) / n);
  return { rows, ranks };
}

describe("distillRuleSet", () => {
  it("learns the teacher's strongest input first, then the next", () => {
    const { rows, ranks } = teacherWorld(2000);
    const conditions = distillRuleSet(rows, ranks, [
      "buys5m",
      "freshTop10WalletPct",
      "mcapUsd",
      "ctxHourSin",
    ])!;
    expect(conditions[0]).toMatchObject({ feature: "buys5m", op: "gte" });
    expect(conditions.some((c) => c.feature === "freshTop10WalletPct" && c.op === "lte")).toBe(true);
    // The clock is never a readable check; points sum to about 100.
    expect(conditions.some((c) => c.feature === "ctxHourSin")).toBe(false);
    const total = conditions.reduce((s, c) => s + c.points, 0);
    expect(total).toBeGreaterThanOrEqual(97);
    expect(total).toBeLessThanOrEqual(103);
    expect(conditions.length).toBeLessThanOrEqual(6);
  });

  it("learns nothing from a teacher that ranks every row alike", () => {
    const { rows } = teacherWorld(500);
    expect(
      distillRuleSet(
        rows,
        rows.map(() => 0.5),
        ["buys5m"],
      ),
    ).toBeNull();
  });

  it("copies the teacher closely enough to agree on most of its top picks", () => {
    const { rows, ranks } = teacherWorld(2000);
    const conditions = distillRuleSet(rows, ranks, ["buys5m", "freshTop10WalletPct", "mcapUsd"])!;
    const scores = rows.map((r) => scoreRuleSet({ conditions }, r.features));
    expect(teacherAgreementPct(ranks, scores)).toBeGreaterThan(50);
  });
});

describe("rule tables", () => {
  const set: Pick<DerivedRuleSet, "conditions"> = {
    conditions: [
      { feature: "freshTop10WalletPct", op: "lte", value: 20, points: 30 },
      { feature: "buys5m", op: "gte", value: 40, points: 70 },
    ],
  };

  it("scores the points of the checks a token passes; an unknown input passes nothing", () => {
    expect(scoreRuleSet(set, { buys5m: 50, freshTop10WalletPct: 10 })).toBe(100);
    expect(scoreRuleSet(set, { buys5m: 50, freshTop10WalletPct: null })).toBe(70);
    expect(scoreRuleSet(set, {})).toBe(0);
  });

  it("reads in plain words, biggest points first", () => {
    expect(describeRuleSet(set)).toEqual(["+70 5m buys at least 40", "+30 fresh-wallet snipers at most 20%"]);
    expect(describeCondition({ feature: "graduated", op: "gte", value: 1, points: 10 })).toBe(
      "graduated to AMM: yes",
    );
    expect(describeCondition({ feature: "buyRatio5m", op: "gte", value: 0.62, points: 10 })).toBe(
      "5m buy pressure at least 62%",
    );
    expect(describeCondition({ feature: "volume1hUsd", op: "gte", value: 12_000, points: 10 })).toBe(
      "1h volume at least $12k",
    );
    expect(ruleSetReasons(set, { buys5m: 50, freshTop10WalletPct: 40 })).toEqual(["5m buys at least 40"]);
  });
});

describe("examineRuleScores", () => {
  it("grades each fold at the cutoff the other folds earned, and refuses folds that don't add up", () => {
    const { rows } = teacherWorld(900);
    const fold = (from: number, to: number): EvalFold => ({
      testFrom: rows[from]!.anchorAt.toISOString(),
      testTo: rows[to - 1]!.anchorAt.toISOString(),
      trainRows: 0,
      testRows: to - from,
      decisionRows: to - from,
      baseWinRatePct: 0,
      meanLabelPerRow: 0,
      model: { emitted: 0, perHour: 0, precisionPct: null, goalPrecisionPct: null, avgLabel: null },
      heuristic: { emitted: 0, perHour: 0, precisionPct: null, goalPrecisionPct: null, avgLabel: null },
    });
    const folds = [fold(0, 300), fold(300, 600), fold(600, 900)];
    const perfect = rows.map((r) => (r.labelValue > 0 ? 100 : 10));
    const cfg = {
      targets: { winRate: 0.75, goalRate: 0, minSupport: 5, confidenceZ: 0 },
      cooldownHours: 24,
      targetPerHour: 0,
    };
    const exam = examineRuleScores(rows, folds, perfect, cfg)!;
    expect(exam.record.calls).toBeGreaterThan(0);
    expect(exam.record.wins).toBe(exam.record.calls);
    expect(exam.outOfSample).toHaveLength(rows.length);
    expect(examineRuleScores(rows, folds.slice(1), perfect, cfg)).toBeNull();
  });
});

describe("the Rules seat in a training run", () => {
  const rows = syntheticMarket({ tokens: 2500, days: 30, truth: "interactions", seed: 11 });
  const cfg: ContestTrainingConfig = {
    targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
    targetPerHour: 6,
    heuristicMinScore: 55,
    minRowsToPromote: 1500,
    recencyHalfLifeDays: 14,
    cooldownHours: 24,
    heuristicPrecisionGate: true,
    contestants: enabledContestants(["linear", "trees"]),
  };
  const rulesOf = async (extra: Partial<ContestTrainingConfig>) => {
    const { results } = await runEvolvingContest(rows, { ...cfg, ...extra });
    return results.find((r) => r.contestant === "rules")!;
  };

  it("stays on the hand-tuned gates when learning is off", async () => {
    const rules = await rulesOf({});
    expect((rules.params as RulesCuratorParams).derived).toBeUndefined();
    expect(rules.metrics.rulesInUse).toBeUndefined();
  }, 60_000);

  it("learns from the named teacher, adopts the table when it tests better, and keeps it on a tie", async () => {
    const first = await rulesOf({ rulesFromBest: true, rulesTeachers: ["linear"] });
    const params = first.params as RulesCuratorParams;
    expect(params.derived?.teacher).toEqual({ contestant: "linear", name: "Linear" });
    expect(params.rankCutoff).not.toBeNull();
    expect(first.metrics.rulesInUse).toMatchObject({ source: "learned", changed: true });
    expect(first.metrics.rulesInUse!.lines.length).toBe(params.derived!.conditions.length);

    // Next run, same evidence: the fresh table ties the one in the seat, which stays.
    const again = await rulesOf({
      rulesFromBest: true,
      rulesTeachers: ["linear"],
      currentRules: params.derived,
    });
    expect((again.params as RulesCuratorParams).derived?.derivedAt).toBe(params.derived!.derivedAt);
    expect(again.metrics.rulesInUse).toMatchObject({ source: "learned", changed: false });
  }, 120_000);

  it("drops a table that can no longer call", async () => {
    const dead: DerivedRuleSet = {
      conditions: [{ feature: "mcapUsd", op: "gte", value: 1e15, points: 100 }],
      teacher: { contestant: "trees", name: "Trees" },
      derivedAt: "2026-10-01T00:00:00.000Z",
      agreementPct: null,
    };
    const rules = await rulesOf({ rulesFromBest: true, rulesTeachers: [], currentRules: dead });
    expect((rules.params as RulesCuratorParams).derived?.derivedAt).not.toBe(dead.derivedAt);
    expect(rules.metrics.rulesInUse!.changed).toBe(true);
  }, 60_000);
});
