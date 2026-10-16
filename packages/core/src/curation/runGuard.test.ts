import { describe, expect, it } from "vitest";
import {
  assessTrainingRun,
  examRegressionAlarms,
  fillRateAlarms,
  firstNonFinite,
  liveShareAlarms,
  type IncumbentModel,
} from "./runGuard.js";
import { NEVER_EMIT_THRESHOLD, RULES_MODEL_KIND, runContestTraining } from "./trainingRun.js";
import { enabledContestants, CONTESTANT_IDS } from "./contestants.js";
import { syntheticMarket } from "./syntheticMarket.js";

const now = new Date("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;

function incumbent(over: Partial<IncumbentModel> = {}): IncumbentModel {
  return {
    contestant: "linear",
    kind: "weighted-logistic-v1",
    threshold: 0.4,
    trainingRows: 80_000,
    activatedAt: new Date(now.getTime() - 2 * HOUR),
    ...over,
  };
}
const learner = (threshold: number, extra: Record<string, unknown> = {}) => ({
  contestant: "linear",
  kind: "weighted-logistic-v1",
  params: { threshold, weights: [0.1, -0.2], ...extra },
});
const base = { maxRows: 100_000, now, maxHoldMs: 24 * HOUR };

describe("assessTrainingRun", () => {
  it("accepts an ordinary run", () => {
    expect(
      assessTrainingRun({
        ...base,
        incumbents: [incumbent()],
        results: [learner(0.5)],
        trainingRows: 82_000,
      }),
    ).toEqual({ accept: true, reason: null });
  });

  it("accepts anything on the first run", () => {
    expect(
      assessTrainingRun({
        ...base,
        incumbents: [],
        results: [learner(NEVER_EMIT_THRESHOLD)],
        trainingRows: 300,
      }).accept,
    ).toBe(true);
  });

  it("never ships non-finite weights, whatever the hold", () => {
    const v = assessTrainingRun({
      ...base,
      maxHoldMs: 0,
      incumbents: [],
      results: [learner(0.5, { weights: [0.1, Number.NaN] })],
      trainingRows: 80_000,
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain("params.weights[1]");
  });

  it("holds a run that lost half its rows, until the running models are maxHold old", () => {
    const shrunk = { ...base, results: [learner(0.5)], trainingRows: 30_000 };
    const held = assessTrainingRun({ ...shrunk, incumbents: [incumbent()] });
    expect(held.accept).toBe(false);
    expect(held.reason).toContain("under half");
    const stale = assessTrainingRun({
      ...shrunk,
      incumbents: [incumbent({ activatedAt: new Date(now.getTime() - 25 * HOUR) })],
    });
    expect(stale.accept).toBe(true);
    expect(stale.reason).toContain("accepted after holding 25h");
    // A running model with no activation time counts as activated now, not at the epoch.
    const legacy = assessTrainingRun({ ...shrunk, incumbents: [incumbent({ activatedAt: null })] });
    expect(legacy.accept).toBe(false);
  });

  it("compares rows only against running models trained under the current loading rules", () => {
    const shrunk = { ...base, results: [learner(0.5)], trainingRows: 30_000 };
    const rowRulesSince = new Date(now.getTime() - HOUR);
    // Live before the rules narrowed the set: its count says nothing about missing rows.
    expect(assessTrainingRun({ ...shrunk, rowRulesSince, incumbents: [incumbent()] })).toEqual({
      accept: true,
      reason: null,
    });
    expect(
      assessTrainingRun({ ...shrunk, rowRulesSince, incumbents: [incumbent({ activatedAt: null })] }).accept,
    ).toBe(true);
    // Live since: still held when rows go missing.
    const since = incumbent({ activatedAt: new Date(now.getTime() - HOUR / 2) });
    const held = assessTrainingRun({ ...shrunk, rowRulesSince, incumbents: [incumbent(), since] });
    expect(held.accept).toBe(false);
    expect(held.reason).toContain("under half");
    // The silence check doesn't depend on it.
    expect(
      assessTrainingRun({
        ...base,
        rowRulesSince,
        incumbents: [incumbent()],
        results: [learner(NEVER_EMIT_THRESHOLD)],
        trainingRows: 30_000,
      }).accept,
    ).toBe(false);
  });

  it("compares against the row cap when the cap was lowered", () => {
    expect(
      assessTrainingRun({
        ...base,
        maxRows: 40_000,
        incumbents: [incumbent()],
        results: [learner(0.5)],
        trainingRows: 40_000,
      }).accept,
    ).toBe(true);
  });

  it("holds a run that would silence every calling seat, but not one where none was calling", () => {
    const silent = [
      learner(NEVER_EMIT_THRESHOLD),
      { contestant: "rules", kind: RULES_MODEL_KIND, params: { rankCutoff: 80 } },
    ];
    expect(
      assessTrainingRun({ ...base, incumbents: [incumbent()], results: silent, trainingRows: 80_000 }).accept,
    ).toBe(false);
    expect(
      assessTrainingRun({
        ...base,
        incumbents: [incumbent({ threshold: NEVER_EMIT_THRESHOLD })],
        results: silent,
        trainingRows: 80_000,
      }).accept,
    ).toBe(true);
  });
});

describe("firstNonFinite", () => {
  it("allows nulls and finds the first bad number", () => {
    expect(firstNonFinite({ a: null, b: [1, 2, { c: 3 }] })).toBeNull();
    expect(firstNonFinite({ a: [1, { b: Infinity }] })).toBe("params.a[1].b");
  });

  it("passes every model a real contest run ships", async () => {
    const rows = syntheticMarket({ tokens: 1500, days: 30, truth: "interactions", seed: 5 });
    const results = await runContestTraining(rows, {
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 },
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1000,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants([...CONTESTANT_IDS]),
    });
    expect(results.length).toBeGreaterThan(3);
    for (const r of results) expect(firstNonFinite(r.params)).toBeNull();
  }, 120_000);
});

describe("run alarms", () => {
  it("flags a seat whose exam fell sharply against the model it replaces", () => {
    const alarms = examRegressionAlarms(
      [
        { contestant: "trees", wins: 60, graded: 250 },
        { contestant: "forest", wins: 55, graded: 250 },
      ],
      [
        { contestant: "trees", wins: 30, graded: 250 },
        { contestant: "forest", wins: 50, graded: 250 },
        { contestant: "new-seat", wins: 1, graded: 250 },
      ],
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatch(/^trees: exam 2x 12\.0% \(30\/250\) against 24\.0%/);
  });

  it("leaves thin exams alone", () => {
    expect(
      examRegressionAlarms(
        [{ contestant: "a", wins: 10, graded: 40 }],
        [{ contestant: "a", wins: 0, graded: 40 }],
      ),
    ).toEqual([]);
  });

  it("flags a seat calling far over its share, and most seats gone quiet", () => {
    const seat = (contestant: string, calls: number, calledBefore = true) => ({
      contestant,
      calls,
      calledBefore,
    });
    // 1,000 decision moments at a 20% share: 450 calls is far over, 230 is not.
    expect(liveShareAlarms([seat("loose", 450), seat("tight", 230)], 1000, 0.2)).toEqual([
      "loose: called 45.0% of 1000 decision moments against a 20.0% share",
    ]);
    expect(
      liveShareAlarms(
        [seat("a", 0), seat("b", 0), seat("c", 0), seat("d", 150), seat("never", 0, false)],
        1000,
        0.2,
      ),
    ).toEqual(["3 of 4 calling seats made no call in 1000 decision moments"]);
    expect(liveShareAlarms([seat("loose", 90)], 150, 0.2)).toEqual([]);
  });

  it("flags a read input gone dead and a retired one filled again", () => {
    const alarms = fillRateAlarms(
      [
        { feature: "liveInput", referencePct: 95, recentPct: 10 },
        { feature: "steady", referencePct: 95, recentPct: 93 },
        { feature: "textMemeAppeal", referencePct: 0, recentPct: 80 },
        { feature: "sparse", referencePct: 5, recentPct: 0 },
      ],
      new Set(["liveInput", "steady", "sparse"]),
      new Set(["textMemeAppeal"]),
    );
    expect(alarms).toEqual([
      "liveInput went dead: 10% of the newest rows against 95%",
      "textMemeAppeal (retired as dead) is filled again on 80% of the newest rows",
    ]);
  });

  it("flags a read input gone dead in one age bucket while full overall, naming the bucket", () => {
    const bucket = (name: string, referencePct: number, recentPct: number) => ({
      bucket: name,
      referencePct,
      recentPct,
      referenceRows: 500,
      recentRows: 120,
    });
    const alarms = fillRateAlarms(
      [
        {
          feature: "holderCount",
          referencePct: 97,
          recentPct: 82,
          buckets: [bucket("age under 5 min", 99, 6), bucket("age 5-20 min", 98, 95)],
        },
        // Sparse on young coins on both spans: steady, no alarm.
        { feature: "steady", referencePct: 80, recentPct: 78, buckets: [bucket("age under 5 min", 10, 2)] },
        // A pooled drop says so once, not once more per bucket.
        { feature: "liveInput", referencePct: 95, recentPct: 10, buckets: [bucket("age 60+ min", 95, 5)] },
      ],
      new Set(["holderCount", "steady", "liveInput"]),
      new Set(),
    );
    expect(alarms).toEqual([
      "holderCount went dead at age under 5 min: 6% of the newest 120 rows against 99%",
      "liveInput went dead: 10% of the newest rows against 95%",
    ]);
  });
});
