import { describe, expect, it } from "vitest";
import {
  applyPriceTick,
  computeOutcomeLabels,
  initialOutcomeAggregates,
  LABEL_LOG2_CAP,
  type OutcomeAggregates,
} from "./labels.js";

const T0 = new Date("2026-08-27T12:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** Replays a sequence of (price, minute) ticks the way the watcher does: fold, merge, repeat. */
function replay(anchorPrice: number, ticks: [price: number, minute: number][]): OutcomeAggregates {
  let agg = initialOutcomeAggregates(anchorPrice, T0);
  for (const [price, minute] of ticks) {
    agg = { ...agg, ...applyPriceTick(agg, price, minutes(minute)) };
  }
  return agg;
}

describe("candidate outcome labels", () => {
  it("labels a token that never ran as a zero, with its drawdown recorded", () => {
    const agg = replay(1, [
      [1.1, 5],
      [0.7, 20],
      [0.9, 45],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBe(0);
    expect(labels.peak1hReturnPct).toBeCloseTo(10);
    expect(labels.maxDrawdown1hPct).toBeCloseTo(-30);
  });

  it("labels a fast, clean 2x as a win worth its doublings", () => {
    const agg = replay(1, [
      [1.2, 3],
      [0.9, 6],
      [2.5, 12],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.5));
    expect(agg.hit2xAt).toEqual(minutes(12));
  });

  it("a 2x that arrives after 15 minutes but inside the hour is still a win", () => {
    // The bar is 2x within the hour - a 40-minute double is a win; hit2xIn15m just records speed.
    const agg = replay(1, [
      [1.4, 10],
      [2.5, 40],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.5));
  });

  it("grades a win on how far it ran by the hour, so the 4x goal is worth double a 2x", () => {
    const stalled = computeOutcomeLabels(replay(1, [[2.1, 10]]));
    const ranOn = computeOutcomeLabels(
      replay(1, [
        [2.1, 10],
        [4.0, 50], // kept running after the win landed - the goal
      ]),
    );
    expect(stalled.hit4xIn1h).toBe(false);
    expect(ranOn.hit4xIn1h).toBe(true);
    expect(stalled.labelValue).toBeCloseTo(Math.log2(2.1));
    expect(ranOn.labelValue).toBeCloseTo(2); // log2(4)
    expect(ranOn.labelValue).toBeGreaterThan(stalled.labelValue);
  });

  it("credits a 4x that arrives late in the hour as the goal it is", () => {
    const agg = replay(1, [[4.0, 45]]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit4xIn1h).toBe(true);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.labelValue).toBeCloseTo(2);
  });

  it("does not count a 4x that first breached the stop", () => {
    const labels = computeOutcomeLabels(
      replay(1, [
        [0.45, 5],
        [4.5, 40],
      ]),
    );
    expect(labels.disqualified).toBe(true);
    expect(labels.hit4xIn1h).toBe(false);
  });

  it("disqualifies a late 2x that first traded at or below half the anchor", () => {
    const agg = replay(1, [
      [0.4, 20],
      [2.2, 50],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });

  it("disqualifies a fast 2x that first traded at or below half the anchor", () => {
    const agg = replay(1, [
      [0.45, 4],
      [2.2, 9],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });

  it("does NOT disqualify for a crash that happens after the 2x", () => {
    const agg = replay(1, [
      [2.0, 5],
      [0.3, 30],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
    // The pre-2x trough froze at the anchor; the post-2x crash only shows in maxDrawdown1hPct.
    expect(agg.lowBefore2xPriceUsd).toBe(1);
    expect(labels.maxDrawdown1hPct).toBeCloseTo(-70);
    expect(labels.labelValue).toBeCloseTo(1);
  });

  it("caps the label so one moonshot cannot outweigh a month of 2xs", () => {
    const agg = replay(1, [[150, 10]]);
    expect(computeOutcomeLabels(agg).labelValue).toBe(LABEL_LOG2_CAP);
  });

  it("counts a first tick that is already a 2x as a clean win", () => {
    const agg = replay(1, [[2.1, 1]]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
  });

  it("treats the exact win-window boundary as inside the window", () => {
    const labels = computeOutcomeLabels(replay(1, [[2.0, 60]]));
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.labelValue).toBeCloseTo(1);
  });

  it("treats the exact 15-minute boundary as a fast double", () => {
    const labels = computeOutcomeLabels(replay(1, [[2.0, 15]]));
    expect(labels.hit2xIn15m).toBe(true);
  });

  it("keeps ticks after the goal window out of the 1h aggregates but in the 24h peak", () => {
    const agg = replay(1, [
      [1.5, 10],
      [3.0, 90], // past the goal window
    ]);
    expect(agg.peak1hPriceUsd).toBe(1.5);
    expect(agg.hit2xAt).toBeNull();
    expect(agg.peak24hPriceUsd).toBe(3.0);
    expect(agg.peak24hAt).toEqual(minutes(90));
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.hit4xIn1h).toBe(false);
  });

  it("ignores zero, negative, and non-finite prices", () => {
    const agg = replay(1, [
      [0, 5],
      [-3, 10],
      [Number.NaN, 15],
    ]);
    expect(agg.peak1hPriceUsd).toBe(1);
    expect(agg.low1hPriceUsd).toBe(1);
  });

  it("labels a row that never got a single tick as a zero with no drawdown claim", () => {
    const labels = computeOutcomeLabels(initialOutcomeAggregates(1, T0));
    expect(labels.labelValue).toBe(0);
    expect(labels.peak1hReturnPct).toBe(0);
    expect(labels.maxDrawdown1hPct).toBe(0);
  });
});

describe("fill-price grading", () => {
  const rule = { delayMs: 60_000, slippageFraction: 0.03 };

  /** Like replay, but through the entry rule - ticks are [price, seconds]. */
  function replayWithEntry(anchorPrice: number, ticks: [price: number, second: number][]): OutcomeAggregates {
    let agg = initialOutcomeAggregates(anchorPrice, T0);
    for (const [price, second] of ticks) {
      agg = { ...agg, ...applyPriceTick(agg, price, new Date(T0.getTime() + second * 1000), rule) };
    }
    return agg;
  }

  it("ignores ticks before the fill, so an instant spike nobody could buy isn't a win", () => {
    const agg = replayWithEntry(1, [
      [2.2, 30], // a 2x inside the first half-minute - before anyone acting on the alert holds it
      [1.3, 70], // the fill
      [1.5, 600],
    ]);
    expect(agg.entryAt).toEqual(new Date(T0.getTime() + 70_000));
    expect(agg.signalPriceUsd).toBe(1);
    expect(agg.anchorPriceUsd).toBeCloseTo(1.3 * 1.03);
    expect(computeOutcomeLabels(agg).hit2xIn1h).toBe(false);
  });

  it("grades the double from the fill plus slippage, not the signal price", () => {
    // 2.4 is a 2.4x from the signal but only 1.79x from a 1.3 fill with 3% slippage.
    const missed = computeOutcomeLabels(
      replayWithEntry(1, [
        [1.3, 65],
        [2.4, 900],
      ]),
    );
    expect(missed.hit2xIn1h).toBe(false);
    const won = computeOutcomeLabels(
      replayWithEntry(1, [
        [1.3, 65],
        [2.8, 900],
      ]),
    );
    expect(won.hit2xIn1h).toBe(true);
  });

  it("never grades from below the signal price, even when the fill tick is cheaper", () => {
    const agg = replayWithEntry(1, [[0.8, 61]]);
    expect(agg.anchorPriceUsd).toBeCloseTo(1.03);
  });

  it("measures the stop from the fill base", () => {
    const labels = computeOutcomeLabels(
      replayWithEntry(1, [
        [1.0, 61],
        [0.5, 300], // below half of the 1.03 base
        [2.5, 1200],
      ]),
    );
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });

  it("a row that never got a tick past the delay grades as a miss", () => {
    const labels = computeOutcomeLabels(replayWithEntry(1, [[3, 20]]));
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.labelValue).toBe(0);
  });
});
