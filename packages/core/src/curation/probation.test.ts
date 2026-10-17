import { describe, expect, it } from "vitest";
import { freshDecisionRows, judgeProbation } from "./probation.js";
import { seededRng } from "./evolution.js";
import { CURATOR_MODEL_KIND, type TrainedCuratorParams, type TrainingRow } from "./trainer.js";

const T0 = Date.UTC(2026, 9, 6, 0, 0, 0);

/**
 * A one-input logistic model on `input` ("scoreTotal" predicts the wins, "noise" doesn't) whose
 * shipped cutoff calls when the input clears `cut` (probability 0.5 there).
 */
function model(input: "scoreTotal" | "noise", cut: number): TrainedCuratorParams {
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: [input],
    means: [0],
    stdevs: [1],
    weights: [5, 0],
    bias: -5 * cut,
    threshold: 0.5,
  } as unknown as TrainedCuratorParams;
}

/** Rows a minute apart from `start`, one token each; x and noise in [0, 1); a row wins when x >= winFrom. */
function rows(start: number, n: number, winFrom: number): TrainingRow[] {
  return Array.from({ length: n }, (_, i) => {
    const x = ((i * 37) % n) / n;
    return {
      tokenId: `t${start}-${i}`,
      anchorAt: new Date(start + i * 60_000),
      anchorPriceUsd: 1,
      anchorMcapUsd: 20_000,
      sampleKind: "event",
      labelRule: 4,
      features: { scoreTotal: x, noise: ((i * 53) % n) / n, ageMinutes: 10 },
      labelValue: x >= winFrom ? 1.2 : 0,
    } as TrainingRow;
  });
}

describe("probation", () => {
  const base = {
    startedAt: new Date(T0),
    cooldownMs: 24 * 3_600_000,
    share: 0.2,
    minWins: 8,
    confidence: 0.9,
    rng: seededRng(1),
  };

  it("grades only decision moments that arrived after the probation began", () => {
    const all = [...rows(T0 - 86_400_000, 50, 0.5), ...rows(T0, 30, 0.5)];
    const hourly = { ...all[60]!, sampleKind: "hourly" as const };
    expect(freshDecisionRows([...all, hourly], new Date(T0))).toHaveLength(30);
  });

  it("confirms a challenger whose top share doubles more often than the seat's", () => {
    // Wins sit at x >= 0.8; the challenger ranks by x, the seat by noise.
    const verdict = judgeProbation({
      ...base,
      rows: rows(T0, 400, 0.8),
      challenger: model("scoreTotal", 0.8),
      lane: model("noise", 0.8),
    });
    expect(verdict.challenger.calls).toBe(80);
    expect(verdict.lane.calls).toBe(80);
    expect(verdict.challenger.wins).toBeGreaterThan(verdict.lane.wins);
    expect(verdict.confirm).toBe(true);
    expect(verdict.reason).toMatch(/^confirmed on 400 fresh decision moments, each side's top 80/);
    expect(verdict.reason).toMatch(/challenger 80\/80 \(2x 100\.0%\)/);
  });

  it("rejects one that is no better, or has too few fresh wins", () => {
    const worse = judgeProbation({
      ...base,
      rows: rows(T0, 400, 0.8),
      challenger: model("noise", 0.8),
      lane: model("scoreTotal", 0.8),
    });
    expect(worse.confirm).toBe(false);
    expect(worse.reason).toMatch(/did not beat the seat on its goal|not ahead/);
    const thin = judgeProbation({
      ...base,
      rows: rows(T0, 30, 0.8),
      challenger: model("scoreTotal", 0.8),
      lane: model("noise", 0.8),
    });
    expect(thin.confirm).toBe(false);
    expect(thin.reason).toMatch(/too few fresh wins/);
  });

  it("compares both at the same share, whatever their frozen cutoffs (no credit for calling more)", () => {
    // The same ranking on both sides: the challenger's frozen cutoff calls 60% of the rows, the
    // seat's 1%. Judged at their cutoffs the challenger caught five times the runners; at an
    // equal share they make the very same calls, so the seat keeps its seat.
    const verdict = judgeProbation({
      ...base,
      rows: rows(T0, 400, 0.8),
      challenger: model("scoreTotal", 0.4),
      lane: model("scoreTotal", 0.99),
    });
    expect(verdict.challenger.calls).toBe(verdict.lane.calls);
    expect(verdict.challenger.wins).toBe(verdict.lane.wins);
    expect(verdict.pairedConfidence).toBe(0);
    expect(verdict.confirm).toBe(false);
    expect(verdict.reason).toMatch(/did not beat the seat on its goal/);
  });

  it("falls back to the seat's frozen volume when no share is set", () => {
    const verdict = judgeProbation({
      ...base,
      share: 0,
      rows: rows(T0, 400, 0.8),
      challenger: model("scoreTotal", 0.4),
      lane: model("noise", 0.5),
    });
    // The seat's frozen cutoff calls the half of the rows with noise >= 0.5.
    expect(verdict.lane.calls).toBe(200);
    expect(verdict.challenger.calls).toBe(200);
  });

  it("ignores rows from before the probation, however good they look for the challenger", () => {
    const old = rows(T0 - 86_400_000, 400, 0.8);
    const fresh = rows(T0, 400, 0.8).map((r) => ({ ...r, labelValue: 0 }));
    const verdict = judgeProbation({
      ...base,
      rows: [...old, ...fresh],
      challenger: model("scoreTotal", 0.8),
      lane: model("noise", 0.8),
    });
    expect(verdict.rows).toBe(400);
    expect(verdict.challenger.wins).toBe(0);
    expect(verdict.confirm).toBe(false);
  });
});
