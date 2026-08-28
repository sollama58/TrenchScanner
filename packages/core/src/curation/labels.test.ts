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

  it("a 2x that only arrives after the win window is a miss, not a win", () => {
    // The whole point of the shorter bar: a token that took 40 minutes to double is exactly the
    // slow grind the 15-minute window exists to stop crediting.
    const agg = replay(1, [
      [1.4, 10],
      [2.5, 40],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.hit2xIn1h).toBe(true); // still recorded, just not the verdict
    expect(labels.disqualified).toBe(false); // a miss is a miss, never "stopped out"
    expect(labels.labelValue).toBe(0);
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

  it("gives a 4x no credit at all unless it cleared the fast bar first", () => {
    // Reaching the goal the slow way is still a miss: the alert never gave anyone a fast double.
    const agg = replay(1, [[4.0, 45]]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit4xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(false);
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
    expect(labels.hit2xIn15m).toBe(false);
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
