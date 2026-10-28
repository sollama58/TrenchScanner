import { describe, expect, it } from "vitest";
import { anchorForWeights, fitScoreWeights, rankAuc, rankQuality, type ScoreFitRow } from "./scoreWeights.js";
import {
  DEFAULT_SCORE_ANCHOR,
  DEFAULT_SCORE_WEIGHTS,
  getScoreAnchor,
  getScoreWeights,
  IDENTITY_SCORE_ANCHOR,
  scoreToken,
  setScoreAnchor,
  setScoreWeights,
  type ScoreAnchor,
  type ScoreWeights,
} from "./scorer.js";

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
    // Narrative stays at its fixed weight; everything still sums to 1 with a floor per part.
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
    const current = { momentum: 0.9, freshness: 0.05, holderQuality: 0.05, narrative: 0 };
    const result = fitScoreWeights(rows("momentum"), current);
    expect(result.adopted).toBe(false);
    expect(result.weights).toEqual(current);
  });
});

/** The p-th quantile of the score a weight set and rescale give the match rows. */
function matchQuantile(rs: ScoreFitRow[], w: ScoreWeights, a: ScoreAnchor, p: number): number {
  const scores = rs
    .filter((r) => r.population === "match")
    .map(
      (r) =>
        a.scale *
          (w.momentum * r.momentum +
            w.freshness * r.freshness +
            w.holderQuality * r.holderQuality +
            w.narrative * (r.narrative ?? 50)) +
        a.offset,
    )
    .sort((x, y) => x - y);
  return scores[Math.round((scores.length - 1) * p)]!;
}

describe("narrative weight", () => {
  it("moves a stored narrative weight to 0 once, spread pro rata and rescaled", () => {
    const rs = rows("freshness").map((r, i) => ({ ...r, narrative: 30 + (i % 41) }));
    const live = { momentum: 0.19, freshness: 0.39, holderQuality: 0.27, narrative: 0.15 };
    const today = { scale: 1.1, offset: -6 };
    const result = fitScoreWeights(rs, live, today);
    expect(result.adopted).toBe(true);
    expect(result.weights).toEqual({ momentum: 0.22, freshness: 0.46, holderQuality: 0.32, narrative: 0 });
    for (const p of [0.1, 0.9]) {
      expect(matchQuantile(rs, result.weights, result.anchor, p)).toBeCloseTo(
        matchQuantile(rs, live, today, p),
        0,
      );
    }
    // The next run fits as usual from there.
    expect(fitScoreWeights(rs, result.weights, result.anchor).weights.narrative).toBe(0);
  });
});

describe("rankQuality", () => {
  it("judges decision moments on the 15-minute 2x alone", () => {
    const rs = rows("momentum");
    const onMomentum = { momentum: 0.9, freshness: 0.05, holderQuality: 0.05 };
    const q = rankQuality(rs, onMomentum)!;
    // Flipping every match's outcome, or every 4x/10x, changes nothing.
    const noisy = rs.map((r) =>
      r.population === "match" ? { ...r, win: !r.win } : { ...r, goal: !r.goal, tenX: !r.tenX },
    );
    expect(rankQuality(noisy, onMomentum)).toBe(q);
    expect(q).toBeGreaterThan(0.6);
  });
});

describe("score rescale on adoption", () => {
  it("keeps the matches' 10th and 90th percentiles where today's score has them", () => {
    const rs = rows("holderQuality");
    const result = fitScoreWeights(rs, DEFAULT_SCORE_WEIGHTS);
    expect(result.adopted).toBe(true);
    for (const p of [0.1, 0.9]) {
      expect(matchQuantile(rs, result.weights, result.anchor, p)).toBeCloseTo(
        matchQuantile(rs, DEFAULT_SCORE_WEIGHTS, IDENTITY_SCORE_ANCHOR, p),
        0,
      );
    }
  });

  it("chains from today's rescale, not from the raw sum", () => {
    const rs = rows("freshness");
    const today = { scale: 1.2, offset: -8 };
    const next = { momentum: 0.25, freshness: 0.55, holderQuality: 0.2, narrative: 0 };
    const anchor = anchorForWeights(rs, DEFAULT_SCORE_WEIGHTS, today, next)!;
    expect(matchQuantile(rs, next, anchor, 0.9)).toBeCloseTo(
      matchQuantile(rs, DEFAULT_SCORE_WEIGHTS, today, 0.9),
      0,
    );
  });

  it("keeps today's rescale when nothing is adopted, and refuses too few rows", () => {
    const today = { scale: 1.1, offset: 3 };
    const current = { momentum: 0.9, freshness: 0.05, holderQuality: 0.05, narrative: 0 };
    expect(fitScoreWeights(rows("momentum"), current, today).anchor).toEqual(today);
    expect(anchorForWeights(rows("momentum", 100), current, today, DEFAULT_SCORE_WEIGHTS)).toBeNull();
  });

  it("is applied by scoreToken, and an unusable rescale is ignored", () => {
    const token = { mintAddress: "m", priceUsd: 1, marketCapUsd: 10_000, narrativeTags: [], ageMinutes: 2 };
    setScoreAnchor(IDENTITY_SCORE_ANCHOR);
    const raw = scoreToken(token).total;
    setScoreAnchor({ scale: 0.5, offset: 10 });
    expect(scoreToken(token).total).toBeCloseTo(raw * 0.5 + 10, 6);
    setScoreAnchor({ scale: 0, offset: 0 });
    expect(getScoreAnchor()).toEqual({ scale: 0.5, offset: 10 });
    setScoreAnchor(DEFAULT_SCORE_ANCHOR);
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
