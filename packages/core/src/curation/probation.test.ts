import { describe, expect, it } from "vitest";
import { freshDecisionRows, judgeProbation } from "./probation.js";
import { seededRng } from "./evolution.js";
import { CURATOR_MODEL_KIND, type TrainedCuratorParams, type TrainingRow } from "./trainer.js";

const T0 = Date.UTC(2026, 9, 6, 0, 0, 0);
const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };

/** A one-input logistic model that calls when feature x clears `cut` (probability 0.5 at x = cut). */
function model(cut: number): TrainedCuratorParams {
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: ["scoreTotal"],
    means: [0],
    stdevs: [1],
    weights: [50, 0],
    bias: -50 * cut,
    threshold: 0.5,
  } as unknown as TrainedCuratorParams;
}

/** Rows a day long from `start`, one token each; x in [0, 1); a row wins when x >= winFrom. */
function rows(start: number, n: number, winFrom: number): TrainingRow[] {
  return Array.from({ length: n }, (_, i) => {
    const x = ((i * 37) % n) / n;
    return {
      tokenId: `t${start}-${i}`,
      anchorAt: new Date(start + i * 60_000),
      anchorPriceUsd: 1,
      anchorMcapUsd: 20_000,
      sampleKind: "event",
      labelRule: 3,
      features: { scoreTotal: x, ageMinutes: 10 },
      labelValue: x >= winFrom ? 1.2 : 0,
    } as TrainingRow;
  });
}

describe("probation", () => {
  const base = {
    startedAt: new Date(T0),
    cooldownMs: 24 * 3_600_000,
    targets,
    minWins: 8,
    confidence: 0.9,
    rng: seededRng(1),
  };

  it("grades only decision moments that arrived after the probation began", () => {
    const all = [...rows(T0 - 86_400_000, 50, 0.5), ...rows(T0, 30, 0.5)];
    const hourly = { ...all[60]!, sampleKind: "hourly" as const };
    expect(freshDecisionRows([...all, hourly], new Date(T0))).toHaveLength(30);
  });

  it("confirms a challenger that calls the winners the seat misses", () => {
    // Wins sit at x >= 0.8; the challenger calls x >= 0.8, the seat calls x >= 0.4 (half losers).
    const verdict = judgeProbation({
      ...base,
      rows: rows(T0, 400, 0.8),
      challenger: model(0.8),
      lane: model(0.4),
    });
    expect(verdict.challenger.wins).toBeGreaterThanOrEqual(8);
    expect(verdict.confirm).toBe(true);
    expect(verdict.reason).toMatch(/^confirmed on 400 fresh decision moments/);
  });

  it("rejects one that is no better, or has too few fresh wins", () => {
    const worse = judgeProbation({
      ...base,
      rows: rows(T0, 400, 0.8),
      challenger: model(0.4),
      lane: model(0.8),
    });
    expect(worse.confirm).toBe(false);
    expect(worse.reason).toMatch(/did not out-score|not ahead/);
    const thin = judgeProbation({
      ...base,
      rows: rows(T0, 30, 0.8),
      challenger: model(0.8),
      lane: model(0.4),
    });
    expect(thin.confirm).toBe(false);
    expect(thin.reason).toMatch(/too few fresh wins/);
  });

  it("ignores rows from before the probation, however good they look for the challenger", () => {
    const old = rows(T0 - 86_400_000, 400, 0.8);
    const fresh = rows(T0, 400, 0.8).map((r) => ({ ...r, labelValue: 0 }));
    const verdict = judgeProbation({
      ...base,
      rows: [...old, ...fresh],
      challenger: model(0.8),
      lane: model(0.4),
    });
    expect(verdict.rows).toBe(400);
    expect(verdict.challenger.wins).toBe(0);
    expect(verdict.confirm).toBe(false);
  });
});
