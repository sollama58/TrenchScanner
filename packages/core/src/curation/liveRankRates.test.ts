import { describe, expect, it } from "vitest";
import {
  buildRankRates,
  liveTierEarned,
  measuredRateAtRank,
  RANK_RATE_MIN_GRADED,
  recalibratedRate,
} from "./liveRankRates.js";

/** n moments for one seat scored 1..n, the top `topWins` of them doubled. */
function rows(n: number, topWins: number, seat = "trees") {
  return Array.from({ length: n }, (_, i) => ({ seatScores: { [seat]: i + 1 }, won: i >= n - topWins }));
}

describe("live rank rates", () => {
  it("bands each seat's graded moments by their rank among that seat's scores", () => {
    const bands = buildRankRates(rows(1000, 20)).get("trees")!;
    // The top 2% is the 20 best scores, all of them winners; nothing below won.
    expect(bands[0]).toEqual({ from: 0.98, graded: 20, wins: 20 });
    expect(bands.slice(1).every((b) => b.wins === 0)).toBe(true);
    expect(bands.reduce((s, b) => s + b.graded, 0)).toBe(1000);
  });

  it("ignores rows without a usable score and keeps seats apart", () => {
    const rates = buildRankRates([
      { seatScores: null, won: true },
      { seatScores: [1, 2], won: true },
      { seatScores: { a: Number.NaN, b: 0.5 }, won: true },
    ]);
    expect(rates.has("a")).toBe(false);
    expect(rates.get("b")!.reduce((s, b) => s + b.graded, 0)).toBe(1);
  });

  it("reads a rate only from a band with enough graded moments", () => {
    const bands = buildRankRates(rows(1000, 10)).get("trees")!;
    // Top 2% holds 20 moments, under the floor; 20-100% holds 800.
    expect(measuredRateAtRank(bands, 0.99)).toBeNull();
    expect(measuredRateAtRank(bands, 0.5)).toBe(0);
    expect(measuredRateAtRank(bands, 0.99, 10)).toBe(0.5);
    expect(RANK_RATE_MIN_GRADED).toBeGreaterThan(20);
  });

  it("replaces the run's rate with the band's measured one both ways, where the band has enough moments", () => {
    const bands = buildRankRates(rows(4000, 16)).get("trees")!;
    // Top 2% is 80 moments with 16 wins: 20%. The 20-100% band holds 3,200 moments, none won.
    expect(recalibratedRate(0.3, bands, 0.99)).toBeCloseTo(0.2);
    expect(recalibratedRate(0.1, bands, 0.99)).toBeCloseTo(0.2);
    expect(recalibratedRate(0.1, bands, 0.5)).toBe(0);
    expect(recalibratedRate(null, bands, 0.99)).toBeCloseTo(0.2);
    expect(recalibratedRate(0.3, undefined, 0.99)).toBe(0.3);
    const thin = buildRankRates(rows(1000, 10)).get("trees")!;
    expect(recalibratedRate(0.3, thin, 0.99)).toBe(0.3);
  });
});

describe("the live high-conviction gate", () => {
  /** A seat's bands from (graded, wins) per band, best first. */
  const bands = (...b: [number, number][]) =>
    b.map(([graded, wins], i) => ({ from: [0.98, 0.95, 0.9, 0.8, 0][i]!, graded, wins }));

  it("tiers high only when the top band clearly out-wins the 2-20% bands", () => {
    // 2-20% at 21% (n 1,631); top 2% at 27.5% of 182 has a 90% lower bound of about 22.6%.
    expect(liveTierEarned(bands([182, 50], [245, 51], [408, 86], [978, 205], [6000, 900]))).toBe(true);
    // 23.6% against 22.2%: higher, but inside the noise.
    expect(liveTierEarned(bands([182, 43], [245, 54], [408, 91], [978, 217], [6000, 900]))).toBe(false);
    // Worse at the top, as most seats were over 10-18..10-25.
    expect(liveTierEarned(bands([182, 34], [245, 55], [408, 91], [978, 219], [6000, 900]))).toBe(false);
  });

  it("needs enough graded moments in both, and no bands means no tier", () => {
    expect(liveTierEarned(bands([20, 20], [100, 10], [200, 20], [400, 40], [3000, 300]))).toBe(false);
    expect(liveTierEarned(bands([20, 20], [100, 10], [200, 20], [400, 40], [3000, 300]), 10)).toBe(true);
    expect(liveTierEarned(undefined)).toBe(false);
    expect(liveTierEarned([])).toBe(false);
  });
});
