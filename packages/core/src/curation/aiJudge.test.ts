import { describe, expect, it } from "vitest";
import {
  buildReflectionBrief,
  decidePlaybookPromotion,
  summarizeJudgeRecord,
  MAX_REFLECTION_CALLS,
  type JudgedCall,
  type ReflectionCall,
} from "./aiJudge.js";
import type { PrecisionTargets } from "./trainer.js";

const targets: PrecisionTargets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };

const call = (decision: "buy" | "no_buy", labelValue: number, p = 0.5): JudgedCall => ({
  decision,
  probability2x: p,
  labelValue,
});

describe("summarizeJudgeRecord", () => {
  it("scores the buys against the pool they were picked from", () => {
    const calls = [
      call("buy", 2.5, 0.9),
      call("buy", 1, 0.8),
      call("buy", 0, 0.7),
      call("no_buy", 0, 0.1),
      call("no_buy", 0, 0.2),
      call("no_buy", 1, 0.3),
      { decision: null, probability2x: null, labelValue: 3 },
    ];
    const s = summarizeJudgeRecord(calls, targets);
    expect(s.reviewed).toBe(6);
    expect(s.buys).toBe(3);
    expect(s.buyWinRatePct).toBeCloseTo(66.67, 1);
    expect(s.buyGoalRatePct).toBeCloseTo(33.33, 1);
    expect(s.baseWinRatePct).toBe(50);
    expect(s.liftPts).toBeCloseTo(16.67, 1);
    expect(s.missedWinnersPct).toBeCloseTo(33.33, 1);
    // (0.1^2 + 0.2^2 + 0.7^2 + 0.1^2 + 0.2^2 + 0.7^2) / 6
    expect(s.brier).toBeCloseTo((0.01 + 0.04 + 0.49 + 0.01 + 0.04 + 0.49) / 6, 6);
    expect(s.curatorBrier).toBeNull();
    expect(s.score).not.toBeNull();
  });

  it("has no rates and no score with nothing reviewed", () => {
    const s = summarizeJudgeRecord([], targets);
    expect(s.buyWinRatePct).toBeNull();
    expect(s.liftPts).toBeNull();
    expect(s.brier).toBeNull();
    expect(s.score).toBeNull();
  });
});

describe("decidePlaybookPromotion", () => {
  const record = (wins: number, buys: number, pool = 60) =>
    summarizeJudgeRecord(
      [
        ...Array.from({ length: buys }, (_, i) => call("buy", i < wins ? 1.5 : 0, i < wins ? 0.7 : 0.3)),
        ...Array.from({ length: pool - buys }, () => call("no_buy", 0, 0.1)),
      ],
      targets,
    );
  const rules = { minGain: 3, minBuys: 10 };

  it("promotes a candidate that clearly beats the incumbent on the same replay", () => {
    const d = decidePlaybookPromotion(record(8, 20), [{ id: "a", summary: record(16, 20) }], rules);
    expect(d.winner).toBe("a");
  });

  it("keeps the incumbent on a small gain, too few buys, or worse odds", () => {
    expect(
      decidePlaybookPromotion(record(10, 20), [{ id: "a", summary: record(10, 20) }], rules).winner,
    ).toBeNull();
    expect(
      decidePlaybookPromotion(record(2, 20), [{ id: "a", summary: record(9, 9) }], rules).winner,
    ).toBeNull();
    const worseOdds = { ...record(16, 20), brier: 0.4 };
    expect(
      decidePlaybookPromotion(record(8, 20), [{ id: "a", summary: worseOdds }], rules).winner,
    ).toBeNull();
  });

  it("picks the best of several candidates", () => {
    const d = decidePlaybookPromotion(
      record(5, 20),
      [
        { id: "a", summary: record(12, 20) },
        { id: "b", summary: record(18, 20) },
      ],
      rules,
    );
    expect(d.winner).toBe("b");
  });
});

describe("buildReflectionBrief", () => {
  const reflection = (decision: "buy" | "no_buy", labelValue: number): ReflectionCall => ({
    decision,
    probability2x: 0.5,
    labelValue,
    stoppedOut: decision === "buy" && labelValue === 0,
    peak1hReturnPct: labelValue > 0 ? 150 : 10,
    curatorProbability: 0.3,
    features: { mcapUsd: 90_000, uniqueBuyers5m: 25, devSoldShare: 0.5 },
  });

  it("lists the costliest mistakes first and summarizes the record", () => {
    const brief = buildReflectionBrief("- old rule", [
      reflection("no_buy", 0),
      reflection("buy", 1),
      reflection("no_buy", 1),
      reflection("buy", 0),
    ]);
    expect(brief).toContain("- old rule");
    expect(brief).toContain("buys: 2, 50% won");
    const rows = brief.split("\n").filter((l) => /^(buy|no_buy) \|/.test(l));
    expect(rows[0]).toMatch(/^buy .*STOPPED OUT$/);
    expect(rows[1]).toMatch(/^no_buy .*WON/);
    expect(brief).toContain("distinct buyers 5m");
  });

  it("caps how many calls it lists", () => {
    const many = Array.from({ length: MAX_REFLECTION_CALLS + 20 }, () => reflection("no_buy", 0));
    const brief = buildReflectionBrief("", many);
    expect(brief.split("\n").filter((l) => l.startsWith("no_buy |"))).toHaveLength(MAX_REFLECTION_CALLS);
    expect(brief).toContain("(empty");
  });
});
