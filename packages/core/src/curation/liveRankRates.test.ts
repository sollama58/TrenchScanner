import { describe, expect, it } from "vitest";
import {
  buildRankRates,
  CARD_BAND_MIN_PCT,
  measuredRateAtRank,
  pooledCalledRate,
  RANK_RATE_MIN_GRADED,
  recalibratedRate,
  servedRate,
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

describe("the served rate and the high tier", () => {
  /** A seat's bands from (graded, wins) per band, best first. */
  const bands = (...b: [number, number][]) =>
    b.map(([graded, wins], i) => ({ from: [0.98, 0.95, 0.9, 0.8, 0][i]!, graded, wins }));
  // Top 2% at 40%, 2-5% at 30%, 5-10% at 20%, 10-20% at 15%; the rest unseen by the cards.
  const seat = bands([200, 80], [300, 90], [500, 100], [1000, 150], [8000, 400]);

  it("pools the bands a seat's calls come from, not the rest", () => {
    expect(pooledCalledRate(seat)).toBeCloseTo(420 / 2000, 6);
    expect(pooledCalledRate(bands([10, 5], [10, 5], [10, 5], [9, 5], [8000, 400]))).toBeNull();
    expect(pooledCalledRate(bands([10, 5], [10, 5], [10, 5], [9, 5], [8000, 400]), 30)).toBeCloseTo(
      20 / 39,
      6,
    );
    expect(pooledCalledRate(undefined)).toBeNull();
  });

  it("quotes the call's own band from the line up, and tiers it high", () => {
    expect(CARD_BAND_MIN_PCT).toBe(35);
    expect(servedRate(0.3, seat, 0.99)).toEqual({ calibratedPct: 40, shownPct: 40, tier: "high" });
  });

  it("quotes the pooled rate under the line, keeps the call's own rate for the desk, and tiers it standard", () => {
    expect(servedRate(0.3, seat, 0.96)).toEqual({ calibratedPct: 30, shownPct: 21, tier: "standard" });
    expect(servedRate(0.5, seat, 0.85)).toEqual({ calibratedPct: 15, shownPct: 21, tier: "standard" });
  });

  it("never tiers high on the run's rate alone, and quotes nothing it can't measure", () => {
    // Too few graded in the top band: the run's rate stands, the pooled rate is quoted.
    const thin = bands([10, 9], [300, 90], [500, 100], [1000, 150], [8000, 400]);
    expect(servedRate(0.6, thin, 0.99)).toEqual({ calibratedPct: 60, shownPct: 19.3, tier: "standard" });
    // No live bands at all: the run's rate, nothing quoted, standard.
    expect(servedRate(0.6, undefined, 0.99)).toEqual({ calibratedPct: 60, shownPct: null, tier: "standard" });
    // No rate anywhere: no tier (rules calls).
    expect(servedRate(null, undefined, 0.5)).toEqual({
      calibratedPct: null,
      shownPct: null,
      tier: undefined,
    });
  });
});
