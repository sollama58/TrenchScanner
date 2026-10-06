import { describe, expect, it } from "vitest";
import { fitScoreWeights, rankAuc, type ScoreFitRow } from "./scoreWeights.js";
import { DEFAULT_SCORE_WEIGHTS, getScoreWeights, scoreToken, setScoreWeights } from "./scorer.js";

/** Rows where only `signal` predicts the outcome; the other two parts are noise. */
function rows(signal: "momentum" | "freshness" | "holderQuality", n = 4_000, seed = 7): ScoreFitRow[] {
  let x = seed;
  const rand = () => {
    x = (x * 1_103_515_245 + 12_345) % 2 ** 31;
    return x / 2 ** 31;
  };
  return Array.from({ length: n }, (_, i) => {
    const parts = { momentum: rand() * 100, freshness: rand() * 100, holderQuality: rand() * 100 };
    const p = 0.02 + 0.3 * (parts[signal] / 100) ** 2;
    const win = rand() < p;
    return {
      anchorAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000),
      population: i % 3 === 0 ? ("event" as const) : ("match" as const),
      ...parts,
      win,
      goal: win && rand() < 0.4,
      tenX: win && rand() < 0.1,
    };
  });
}

describe("rankAuc", () => {
  it("is 1 for a perfect ranking, 0.5 for ties, null for too few hits", () => {
    const labels = [false, false, false, false, false, true, true, true, true, true];
    expect(rankAuc([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], labels)).toBe(1);
    expect(rankAuc(new Array(10).fill(1), labels)).toBe(0.5);
    expect(rankAuc([1, 2, 3], [false, true, false])).toBeNull();
  });
});

describe("fitScoreWeights", () => {
  it("moves weight toward the part that predicts wins, half a step at a time", () => {
    const result = fitScoreWeights(rows("holderQuality"), DEFAULT_SCORE_WEIGHTS);
    expect(result.adopted).toBe(true);
    expect(result.weights.holderQuality).toBeGreaterThan(DEFAULT_SCORE_WEIGHTS.holderQuality);
    expect(result.weights.momentum).toBeLessThan(DEFAULT_SCORE_WEIGHTS.momentum);
    // Half way, not all the way, to the fit.
    expect(result.weights.holderQuality).toBeLessThan(result.fitted!.holderQuality);
    // Narrative is held while it is a constant; everything still sums to 1 with a floor per part.
    expect(result.weights.narrative).toBe(DEFAULT_SCORE_WEIGHTS.narrative);
    const w = result.weights;
    expect(w.momentum + w.freshness + w.holderQuality + w.narrative).toBeCloseTo(1, 6);
    expect(Math.min(w.momentum, w.freshness, w.holderQuality)).toBeGreaterThanOrEqual(0.05);
  });

  it("keeps today's weights when there are too few wins", () => {
    const thin = rows("momentum", 300).map((r) => ({ ...r, win: false, goal: false, tenX: false }));
    const result = fitScoreWeights(thin, DEFAULT_SCORE_WEIGHTS);
    expect(result.adopted).toBe(false);
    expect(result.weights).toEqual(DEFAULT_SCORE_WEIGHTS);
  });

  it("keeps today's weights when a change wouldn't rank the newest rows better", () => {
    // Already all-in on the predictive part: any step can only match or lose.
    const current = { momentum: 0.75, freshness: 0.05, holderQuality: 0.05, narrative: 0.15 };
    const result = fitScoreWeights(rows("momentum"), current);
    expect(result.adopted).toBe(false);
    expect(result.weights).toEqual(current);
  });
});

describe("setScoreWeights", () => {
  it("changes how scoreToken weighs the parts, and ignores an unusable set", () => {
    const token = { mintAddress: "m", priceUsd: 1, marketCapUsd: 10_000, narrativeTags: [], ageMinutes: 2 };
    const before = scoreToken(token).total;
    setScoreWeights({ momentum: 0.1, freshness: 0.7, holderQuality: 0.05, narrative: 0.15 });
    expect(scoreToken(token).total).toBeGreaterThan(before);
    setScoreWeights({ momentum: Number.NaN, freshness: 1, holderQuality: 0, narrative: 0 });
    expect(getScoreWeights().freshness).toBeCloseTo(0.7, 6);
    setScoreWeights(DEFAULT_SCORE_WEIGHTS);
  });
});
