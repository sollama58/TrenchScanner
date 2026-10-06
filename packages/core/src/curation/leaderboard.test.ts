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

function record(graded: number, wins: number, goals: number, avgLabel: number, tenX = 0): CallRecord {
  return { calls: graded, graded, wins, goals, tenX, sumLabel: avgLabel * graded };
}

describe("recordScore", () => {
  it("is null with nothing graded", () => {
    expect(recordScore(emptyRecord(), targets)).toBeNull();
  });

  it("is 100 for a long record that meets every target, and no more for beating them", () => {
    expect(recordScore(record(1000, 900, 700, 2.5, 200), targets)).toBe(100);
    expect(recordScore(record(1000, 1000, 1000, 3, 1000), targets)).toBe(100);
    // Without a single 10x it can't: that part is 10 of the 100.
    expect(recordScore(record(1000, 900, 700, 2.5), targets)).toBe(90);
  });

  it("discounts a short perfect streak below a long good record", () => {
    const streak = recordScore(record(3, 3, 3, 3, 3), targets)!;
    const steady = recordScore(record(200, 150, 100, 1.6, 30), targets)!;
    expect(streak).toBeLessThan(steady);
    // 3 of 3 proves 3 / (3 + 10) = 23% of each rate.
    expect(scoreParts(record(3, 3, 3, 3), targets)).toMatchObject({ proven2xPct: 23.1, proven4xPct: 23.1 });
    // 3 of 3 averaging 3 doublings proves 9 / 13 = 0.69 doublings a call.
    expect(streak).toBeCloseTo(50 * (23.1 / 75) + 30 * (23.1 / 50) + 10 * 1 + 10 * (0.69 / 2), 0);
    expect(steady).toBeGreaterThan(90);
  });

  it("orders records by how close they come to the targets", () => {
    const weak = recordScore(record(100, 30, 10, 0.4), targets)!;
    const better = recordScore(record(100, 60, 30, 0.9), targets)!;
    expect(better).toBeGreaterThan(weak);
  });

  it("ranks the record whose calls ran further higher when the hit rates are the same", () => {
    const short = recordScore(record(100, 40, 20, 0.5), targets)!;
    const long = recordScore(record(100, 40, 20, 1.5), targets)!;
    expect(long).toBeGreaterThan(short);
    // 0.5 vs 1.5 doublings a call over 110 proven calls: 10 × (1 / 1.1) / 2 ≈ 4.5 points apart.
    expect(long - short).toBeCloseTo(4.5, 0);
  });

  it("reads run size from sumRun when the record tracks it, sumLabel otherwise", () => {
    const base = record(100, 40, 20, 0.5);
    const runner = { ...base, sumRun: 150 };
    expect(scoreParts(base, targets)!.provenRunDoublings).toBeCloseTo(50 / 110, 2);
    expect(scoreParts(runner, targets)!.provenRunDoublings).toBeCloseTo(150 / 110, 2);
    expect(recordScore(runner, targets)!).toBeGreaterThan(recordScore(base, targets)!);
  });

  it("caps run size at its target like the rates", () => {
    expect(scoreParts({ ...record(1000, 0, 0, 0), sumRun: 6000 }, targets)!.pointsRun).toBe(10);
  });

  it("is 50 points of 2x rate, 30 of 4x rate, 10 of 10x rate and 10 of run size, each the proven share of its target", () => {
    const parts = scoreParts(record(400, 300, 100, 1, 20), targets)!;
    // 75% raw on 400 calls proves 300/410 = 73%; 25% raw proves 24%; 1 doubling a call proves 0.98.
    expect(parts.proven2xPct).toBeGreaterThan(70);
    expect(parts.proven2xPct).toBeLessThan(75);
    expect(parts.points2x).toBeCloseTo(50 * (parts.proven2xPct / 75), 0);
    expect(parts.points4x).toBeCloseTo(30 * (parts.proven4xPct / 50), 0);
    expect(parts.provenRunDoublings).toBeCloseTo(400 / 410, 2);
    expect(parts.pointsRun).toBeCloseTo(10 * (parts.provenRunDoublings / 2), 0);
    // 20 of 400 proves 20/410 = 4.9% against the 10% target.
    expect(parts.proven10xPct).toBeCloseTo(4.9, 1);
    expect(parts.points10x).toBeCloseTo(10 * (parts.proven10xPct / 10), 0);
    expect(recordScore(record(400, 300, 100, 1, 20), targets)).toBeCloseTo(
      parts.points2x + parts.points4x + parts.points10x + parts.pointsRun,
      1,
    );
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
    // Neither record tracks sumRun, so both fall back to their label sums: 5 + 240 × 0.1.
    expect(pooled.record.sumRun).toBeCloseTo(5 + 24, 6);
  });

  it("pools a live run sum with the backtest's label sum", () => {
    const live = { ...record(10, 4, 1, 0.5), sumRun: 9 };
    const pooled = pooledRecord(live, record(30, 15, 6, 0.8));
    expect(pooled.record.sumRun).toBeCloseTo(9 + 24, 6);
  });

  it("uses a small backtest as it is", () => {
    const pooled = pooledRecord(emptyRecord(), record(12, 6, 3, 1));
    expect(pooled.backtestCalls).toBe(12);
    expect(pooled.record).toEqual({ ...record(12, 6, 3, 1), sumRun: 12 });
    expect(pooledRecord(record(10, 5, 2, 1, 2), record(12, 6, 3, 1, 1)).record.tenX).toBe(3);
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
