import { describe, expect, it } from "vitest";
import {
  BACKTEST_EVIDENCE_CAP,
  compositeScore,
  emptyRecord,
  explainScore,
  pooledRecord,
  rankByComposite,
  recordScore,
  scoreBand,
  scoreParts,
  type CallRecord,
} from "./leaderboard.js";

const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };

function record(graded: number, wins: number, goals: number, avgLabel: number): CallRecord {
  return { calls: graded, graded, wins, goals, sumLabel: avgLabel * graded };
}

describe("recordScore", () => {
  it("is null with nothing graded", () => {
    expect(recordScore(emptyRecord(), targets)).toBeNull();
  });

  it("is 100 for a long record that meets both targets, and no more for beating them", () => {
    expect(recordScore(record(1000, 900, 700, 2.5), targets)).toBe(100);
    expect(recordScore(record(1000, 1000, 1000, 3), targets)).toBe(100);
  });

  it("discounts a short perfect streak below a long good record", () => {
    const streak = recordScore(record(3, 3, 3, 3), targets)!;
    const steady = recordScore(record(200, 150, 100, 1.6), targets)!;
    expect(streak).toBeLessThan(steady);
    // 3 of 3 proves 3 / (3 + 10) = 23% of each rate.
    expect(scoreParts(record(3, 3, 3, 3), targets)).toMatchObject({ proven2xPct: 23.1, proven4xPct: 23.1 });
    expect(streak).toBeCloseTo(60 * (23.1 / 75) + 40 * (23.1 / 50), 0);
    expect(steady).toBeGreaterThan(90);
  });

  it("orders records by how close they come to the targets", () => {
    const weak = recordScore(record(100, 30, 10, 0.4), targets)!;
    const better = recordScore(record(100, 60, 30, 0.9), targets)!;
    expect(better).toBeGreaterThan(weak);
  });

  it("ignores the average return: two records with the same hit rates score the same", () => {
    expect(recordScore(record(100, 40, 20, 0.5), targets)).toBe(
      recordScore(record(100, 40, 20, 1.5), targets),
    );
  });

  it("is 60 points of 2x rate and 40 of 4x rate, each the proven rate's share of its target", () => {
    const parts = scoreParts(record(400, 300, 100, 1), targets)!;
    // 75% raw on 400 calls proves 300/410 = 73%; 25% raw proves 24%.
    expect(parts.proven2xPct).toBeGreaterThan(70);
    expect(parts.proven2xPct).toBeLessThan(75);
    expect(parts.points2x).toBeCloseTo(60 * (parts.proven2xPct / 75), 0);
    expect(parts.points4x).toBeCloseTo(40 * (parts.proven4xPct / 50), 0);
    expect(recordScore(record(400, 300, 100, 1), targets)).toBeCloseTo(parts.points2x + parts.points4x, 1);
  });
});

describe("scoreBand", () => {
  it("names the bands by round thresholds", () => {
    expect(scoreBand(null)).toBeNull();
    expect(scoreBand(0)!.id).toBe("far-off");
    expect(scoreBand(29.9)!.id).toBe("far-off");
    expect(scoreBand(30)!.id).toBe("getting-there");
    expect(scoreBand(60)!.id).toBe("closing-in");
    expect(scoreBand(90)!.id).toBe("on-target");
    expect(scoreBand(100)!.id).toBe("on-target");
  });
});

describe("pooledRecord", () => {
  it("adds the backtest as at most the cap's worth of calls, scaled down", () => {
    const live = record(10, 4, 1, 0.5);
    const exam = record(300, 150, 60, 0.8);
    const pooled = pooledRecord(live, exam);
    expect(pooled.backtestCalls).toBe(BACKTEST_EVIDENCE_CAP);
    expect(pooled.record.graded).toBe(10 + BACKTEST_EVIDENCE_CAP);
    expect(pooled.record.wins).toBeCloseTo(4 + 15, 6);
    expect(pooled.record.goals).toBeCloseTo(1 + 6, 6);
  });

  it("uses a small backtest as it is", () => {
    const pooled = pooledRecord(emptyRecord(), record(12, 6, 3, 1));
    expect(pooled.backtestCalls).toBe(12);
    expect(pooled.record).toEqual(record(12, 6, 3, 1));
  });
});

describe("compositeScore", () => {
  it("uses the exam alone before any live call is graded, worth at most the cap in calls", () => {
    const exam = record(80, 50, 25, 1);
    const c = compositeScore(emptyRecord(), exam, targets);
    expect(c.liveWeight).toBe(0);
    expect(c.basis).toMatchObject({ liveCalls: 0, backtestCalls: BACKTEST_EVIDENCE_CAP, evidenceCalls: 30 });
    expect(c.score).toBe(recordScore(pooledRecord(emptyRecord(), exam).record, targets));
    // Trusting the backtest for 30 calls proves less than 80 live calls would.
    expect(c.score).toBeLessThan(recordScore(exam, targets)!);
  });

  it("weighs live and exam equally at the cap", () => {
    const exam = record(80, 70, 50, 2);
    const live = record(30, 10, 2, 0.3);
    const c = compositeScore(live, exam, targets);
    expect(c.liveWeight).toBe(0.5);
    expect(c.basis!.evidenceCalls).toBe(60);
  });

  it("is the live record alone with no exam", () => {
    const live = record(40, 20, 8, 0.7);
    const c = compositeScore(live, emptyRecord(), targets);
    expect(c.liveWeight).toBe(1);
    expect(c.score).toBe(recordScore(live, targets));
    expect(c.band).not.toBeNull();
  });

  it("is null when neither record has anything graded", () => {
    const c = compositeScore(emptyRecord(), emptyRecord(), targets);
    expect(c.score).toBeNull();
    expect(c.band).toBeNull();
    expect(c.basis).toBeNull();
    expect(c.liveWeight).toBe(0);
  });

  it("explains itself in a sentence", () => {
    const c = compositeScore(record(40, 20, 8, 0.7), record(100, 60, 30, 1), targets);
    const text = explainScore(c, targets);
    expect(text).toContain("40 graded live calls plus the backtest counting as 30");
    expect(text).toContain(`= ${c.score!.toFixed(0)} of 100`);
    expect(explainScore(compositeScore(emptyRecord(), emptyRecord(), targets), targets)).toContain(
      "No graded calls",
    );
  });
});

describe("rankByComposite", () => {
  it("ranks higher scores first, unscored last, and breaks ties on live evidence", () => {
    const entry = (id: string, live: CallRecord, exam: CallRecord) => ({
      id,
      composite: compositeScore(live, exam, targets),
    });
    const ranked = rankByComposite([
      entry("none", emptyRecord(), emptyRecord()),
      entry("low", emptyRecord(), record(50, 10, 2, 0.2)),
      entry("high", emptyRecord(), record(50, 40, 25, 1.8)),
    ]);
    expect(ranked.map((e) => e.id)).toEqual(["high", "low", "none"]);
  });

  it("ranks seasoned models above warming-up ones whatever their scores", () => {
    const entry = (id: string, live: CallRecord) => ({
      id,
      composite: compositeScore(live, emptyRecord(), targets),
    });
    const ranked = rankByComposite([
      entry("hot", record(12, 11, 9, 2)),
      entry("steady", record(80, 30, 10, 0.5)),
    ]);
    expect(ranked.map((e) => e.id)).toEqual(["steady", "hot"]);
  });
});
