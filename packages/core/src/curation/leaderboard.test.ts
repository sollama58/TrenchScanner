import { describe, expect, it } from "vitest";
import { compositeScore, emptyRecord, rankByComposite, recordScore, type CallRecord } from "./leaderboard.js";

const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };

function record(graded: number, wins: number, goals: number, avgLabel: number): CallRecord {
  return { calls: graded, graded, wins, goals, sumLabel: avgLabel * graded };
}

describe("recordScore", () => {
  it("is null with nothing graded", () => {
    expect(recordScore(emptyRecord(), targets)).toBeNull();
  });

  it("tops out near 100 for a long record that meets both targets and averages a 4x", () => {
    expect(recordScore(record(1000, 900, 700, 2.5), targets)).toBeGreaterThan(99);
  });

  it("discounts a short perfect streak below a long good record", () => {
    const streak = recordScore(record(3, 3, 3, 3), targets)!;
    const steady = recordScore(record(200, 150, 100, 1.6), targets)!;
    expect(streak).toBeLessThan(steady);
  });

  it("orders records by how close they come to the targets", () => {
    const weak = recordScore(record(100, 30, 10, 0.4), targets)!;
    const better = recordScore(record(100, 60, 30, 0.9), targets)!;
    expect(better).toBeGreaterThan(weak);
  });
});

describe("compositeScore", () => {
  it("uses the exam alone before any live call is graded", () => {
    const exam = record(80, 50, 25, 1);
    const c = compositeScore(emptyRecord(), exam, targets);
    expect(c.liveWeight).toBe(0);
    expect(c.score).toBe(recordScore(exam, targets));
  });

  it("weighs live and exam equally at the pivot", () => {
    const exam = record(80, 70, 50, 2);
    const live = record(30, 10, 2, 0.3);
    const c = compositeScore(live, exam, targets);
    expect(c.liveWeight).toBe(0.5);
    expect(c.score).toBeCloseTo((c.live.score! + c.exam.score!) / 2, 0);
  });

  it("is null when neither record has anything graded", () => {
    expect(compositeScore(emptyRecord(), emptyRecord(), targets).score).toBeNull();
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
});
