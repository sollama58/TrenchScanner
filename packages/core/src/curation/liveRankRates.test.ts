import { describe, expect, it } from "vitest";
import {
  buildRankRates,
  cappedCalibratedRate,
  measuredRateAtRank,
  RANK_RATE_MIN_GRADED,
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

  it("only ever lowers the run's rate", () => {
    const bands = buildRankRates(rows(4000, 16)).get("trees")!;
    // Top 2% is 80 moments with 16 wins: 20%.
    expect(cappedCalibratedRate(0.3, bands, 0.99)).toBeCloseTo(0.2);
    expect(cappedCalibratedRate(0.1, bands, 0.99)).toBe(0.1);
    expect(cappedCalibratedRate(null, bands, 0.99)).toBeNull();
    expect(cappedCalibratedRate(0.3, undefined, 0.99)).toBe(0.3);
  });
});
