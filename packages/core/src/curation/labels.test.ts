import { describe, expect, it } from "vitest";
import {
  applyPriceTick,
  computeOneHourLabels,
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
    const labels = computeOneHourLabels(agg);
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBe(0);
    expect(labels.peak1hReturnPct).toBeCloseTo(10);
    expect(labels.maxDrawdown1hPct).toBeCloseTo(-30);
  });

  it("labels a clean 2x as a win worth its doublings", () => {
    const agg = replay(1, [
      [1.2, 5],
      [0.9, 15],
      [2.5, 40],
    ]);
    const labels = computeOneHourLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.5));
    expect(agg.hit2xAt).toEqual(minutes(40));
  });

  it("disqualifies a 2x that first traded at or below half the anchor", () => {
    const agg = replay(1, [
      [0.45, 10],
      [2.2, 30],
    ]);
    const labels = computeOneHourLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });

  it("does NOT disqualify for a crash that happens after the 2x", () => {
    const agg = replay(1, [
      [2.0, 10],
      [0.3, 30],
    ]);
    const labels = computeOneHourLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(false);
    // The pre-2x trough froze at the anchor; the post-2x crash only shows in maxDrawdown1hPct.
    expect(agg.lowBefore2xPriceUsd).toBe(1);
    expect(labels.maxDrawdown1hPct).toBeCloseTo(-70);
    expect(labels.labelValue).toBeCloseTo(1);
  });

  it("caps the label so one moonshot cannot outweigh a month of 2xs", () => {
    const agg = replay(1, [[40, 30]]);
    expect(computeOneHourLabels(agg).labelValue).toBe(LABEL_LOG2_CAP);
  });

  it("counts a first tick that is already a 2x as a clean win", () => {
    const agg = replay(1, [[2.1, 1]]);
    const labels = computeOneHourLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(false);
  });

  it("keeps ticks after the label window out of the 1h aggregates but in the 24h peak", () => {
    const agg = replay(1, [
      [1.5, 30],
      [3.0, 90], // past the 1h window
    ]);
    expect(agg.peak1hPriceUsd).toBe(1.5);
    expect(agg.hit2xAt).toBeNull();
    expect(agg.peak24hPriceUsd).toBe(3.0);
    expect(agg.peak24hAt).toEqual(minutes(90));
    expect(computeOneHourLabels(agg).hit2xIn1h).toBe(false);
  });

  it("treats the exact window boundary as inside the window", () => {
    const agg = replay(1, [[2.0, 60]]);
    expect(agg.hit2xAt).toEqual(minutes(60));
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
    const labels = computeOneHourLabels(initialOutcomeAggregates(1, T0));
    expect(labels.labelValue).toBe(0);
    expect(labels.peak1hReturnPct).toBe(0);
    expect(labels.maxDrawdown1hPct).toBe(0);
  });
});
