import { describe, expect, it } from "vitest";
import { assessTrainingRun, firstNonFinite, type IncumbentModel } from "./runGuard.js";
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
