import { describe, expect, it } from "vitest";
import {
  coinDevLaunch,
  devLaunchMarket,
  devLaunchScore,
  EMPTY_DEV_LAUNCH_STATS,
  minusLaunches,
  RISKY_DEV_LAUNCH_SCORE,
} from "./devLaunchScore.js";

// About the market on 10-12..10-17: 5% of launches reach the band, 15% of graded ones double, 80% stop.
const market = devLaunchMarket({ launches: 1000, inBand: 50, graded: 40, wins: 6, stops: 32 });
const stats = (s: Partial<typeof EMPTY_DEV_LAUNCH_STATS>) => ({ ...EMPTY_DEV_LAUNCH_STATS, ...s });

describe("devLaunchScore", () => {
  it("reads the market's rates", () => {
    expect(market).toEqual({ bandRate: 0.05, winRate: 0.15, stopRate: 0.8 });
  });

  it("has no score without a launch", () => {
    expect(devLaunchScore(EMPTY_DEV_LAUNCH_STATS, market)).toBeNull();
  });

  it("puts a serial launcher whose coins all died, or all stopped, above the risky line", () => {
    const dead = devLaunchScore(stats({ launches: 12 }), market)!;
    expect(dead).toBeGreaterThanOrEqual(RISKY_DEV_LAUNCH_SCORE - 10);
    const stopped = devLaunchScore(stats({ launches: 8, inBand: 6, graded: 6, stops: 6 }), market)!;
    expect(stopped).toBeGreaterThan(devLaunchScore(stats({ launches: 1, inBand: 1 }), market)!);
  });

  it("reads a dev whose graded launches doubled as low risk", () => {
    const winner = devLaunchScore(stats({ launches: 3, inBand: 3, graded: 3, wins: 2, stops: 1 }), market)!;
    expect(winner).toBeLessThan(20);
  });

  it("moves little on one launch: the record is smoothed toward the market", () => {
    const one = devLaunchScore(stats({ launches: 1 }), market)!;
    expect(one).toBeGreaterThan(30);
    expect(one).toBeLessThan(45);
  });

  it("stays inside 0-100 on a market with no grades yet", () => {
    const thin = devLaunchMarket({ launches: 10, inBand: 0, graded: 0, wins: 0, stops: 0 });
    for (const s of [stats({ launches: 50 }), stats({ launches: 2, inBand: 2, graded: 2, wins: 2 })]) {
      const score = devLaunchScore(s, thin)!;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("coinDevLaunch", () => {
  const own = stats({ launches: 1, inBand: 1, graded: 1, wins: 1 });

  it("takes the coin's own launch back out of its creator's record", () => {
    const r = coinDevLaunch(
      { ...stats({ launches: 3, inBand: 2, graded: 2, wins: 1, stops: 1 }), funder: null },
      undefined,
      own,
      market,
    );
    expect(r).toMatchObject({
      devLaunchPrior: 2,
      devLaunchPriorInBand: 1,
      devLaunchPriorGraded: 1,
      devLaunchPriorWins: 0,
      devLaunchFamilyCreators: 0,
      devLaunchFamilyLaunches: 0,
    });
    expect(r.devLaunchRisk).toBe(
      devLaunchScore(stats({ launches: 2, inBand: 1, graded: 1, stops: 1 }), market),
    );
  });

  it("has no score for a first launch, but says it has no other launches", () => {
    const r = coinDevLaunch({ ...own, funder: null }, undefined, own, market);
    expect(r.devLaunchPrior).toBe(0);
    expect(r.devLaunchRisk).toBeNull();
    expect(coinDevLaunch(undefined, undefined, EMPTY_DEV_LAUNCH_STATS, market).devLaunchPrior).toBe(0);
  });

  it("reads a new creator from a known farm's funder by its family", () => {
    const family = { ...stats({ launches: 30 }), creators: 10 };
    const r = coinDevLaunch(undefined, family, EMPTY_DEV_LAUNCH_STATS, market);
    expect(r.devLaunchFamilyCreators).toBe(10);
    expect(r.devLaunchFamilyLaunches).toBe(30);
    expect(r.devLaunchRisk).toBe(devLaunchScore(stats({ launches: 30 }), market));
  });

  it("reads the family without the creator itself when the rebuild filed it there", () => {
    const entry = { ...stats({ launches: 4, inBand: 1 }), funder: "F" };
    const family = { ...stats({ launches: 10, inBand: 1 }), creators: 3 };
    const r = coinDevLaunch(entry, family, stats({ launches: 1 }), market);
    expect(r.devLaunchFamilyCreators).toBe(2);
    expect(r.devLaunchFamilyLaunches).toBe(6);
    // The pooled record: the creator's 3 other launches (1 in band) and the family's other 6.
    expect(r.devLaunchRisk).toBe(devLaunchScore(stats({ launches: 9, inBand: 1 }), market));
  });

  it("never reads a count below zero", () => {
    expect(minusLaunches(EMPTY_DEV_LAUNCH_STATS, own)).toEqual(EMPTY_DEV_LAUNCH_STATS);
  });
});
