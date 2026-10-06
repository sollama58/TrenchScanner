import { describe, expect, it } from "vitest";
import {
  applyPriceTick,
  computeOutcomeLabels,
  initialOutcomeAggregates,
  LABEL_LOG2_CAP,
  RUN_WEIGHT_PER_DOUBLING,
  runDoublings,
  runWeight,
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

  it("a 2x that arrives after 15 minutes is a miss", () => {
    // The bar is 2x within 15 minutes - a 20-minute double is too late, even inside the window.
    const agg = replay(1, [
      [1.4, 10],
      [2.5, 20],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(agg.hit2xAt).toEqual(minutes(20));
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBe(0);
  });

  it("grades a win on how far it ran by 30 minutes, so the 4x goal is worth double a 2x", () => {
    const stalled = computeOutcomeLabels(replay(1, [[2.1, 10]]));
    const ranOn = computeOutcomeLabels(
      replay(1, [
        [2.1, 10],
        [4.0, 25], // kept running after the win landed - the goal
      ]),
    );
    expect(stalled.hit4xIn1h).toBe(false);
    expect(ranOn.hit4xIn1h).toBe(true);
    expect(stalled.labelValue).toBeCloseTo(Math.log2(2.1));
    expect(ranOn.labelValue).toBeCloseTo(2); // log2(4)
    expect(ranOn.labelValue).toBeGreaterThan(stalled.labelValue);
  });

  it("credits a 4x at minute 30 after a 15-minute double as the goal it is", () => {
    const agg = replay(1, [
      [2.2, 14],
      [4.0, 30],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit4xIn1h).toBe(true);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.labelValue).toBeCloseTo(2);
  });

  it("does not count a 4x that lands after 30 minutes", () => {
    const agg = replay(1, [
      [2.2, 10],
      [3.0, 28],
      [4.5, 40], // past the goal window: the run peak, not the goal
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(3));
    expect(agg.peak24hPriceUsd).toBe(4.5);
  });

  it("does not count a 4x by a call that doubled too late", () => {
    const labels = computeOutcomeLabels(replay(1, [[4.0, 20]]));
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBe(0);
  });

  it("does not count a 4x that first breached the stop", () => {
    const labels = computeOutcomeLabels(
      replay(1, [
        [0.45, 5],
        [4.5, 12],
      ]),
    );
    expect(labels.disqualified).toBe(true);
    expect(labels.hit4xIn1h).toBe(false);
  });

  it("does not count a 4x reached only after a post-2x fall through the stop", () => {
    // Doubled cleanly, then fell to 45% of the alert price (a stop-out), then ran to 4.2x. Still a 2x
    // win - the double came first - but the 4x is not one a buyer holding to the stop traded.
    const labels = computeOutcomeLabels(
      replay(1, [
        [2.1, 10],
        [0.45, 20],
        [4.2, 28],
      ]),
    );
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.1));
    expect(labels.peak1hReturnPct).toBeCloseTo(320); // the raw peak is still recorded
  });

  it("falls back to the window peak on rows that predate the stop-aware peak", () => {
    const agg = { ...replay(1, [[4.5, 12]]), peakBeforeStopPriceUsd: null, stoppedAt: null };
    expect(computeOutcomeLabels(agg).hit4xIn1h).toBe(true);
  });

  it("disqualifies a 2x that first traded at or below half the anchor", () => {
    const agg = replay(1, [
      [0.4, 8],
      [2.2, 14],
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
    const labels = computeOutcomeLabels(replay(1, [[2.0, 15]]));
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.labelValue).toBeCloseTo(1);
  });

  it("treats the exact 30-minute boundary as inside the goal window", () => {
    const labels = computeOutcomeLabels(
      replay(1, [
        [2.0, 5],
        [4.0, 30],
      ]),
    );
    expect(labels.hit4xIn1h).toBe(true);
  });

  it("keeps ticks after the goal window out of the window aggregates but in the run peak", () => {
    const agg = replay(1, [
      [1.5, 10],
      [3.0, 45], // past the goal window
    ]);
    expect(agg.peak1hPriceUsd).toBe(1.5);
    expect(agg.hit2xAt).toBeNull();
    expect(agg.peak24hPriceUsd).toBe(3.0);
    expect(agg.peak24hAt).toEqual(minutes(45));
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

describe("alert-price grading", () => {
  /** Ticks are [price, seconds after the alert]. */
  function replayAt(anchorPrice: number, ticks: [price: number, second: number][]): OutcomeAggregates {
    let agg = initialOutcomeAggregates(anchorPrice, T0);
    for (const [price, second] of ticks) {
      agg = { ...agg, ...applyPriceTick(agg, price, new Date(T0.getTime() + second * 1000)) };
    }
    return agg;
  }

  it("grades from the alert price, with no delay and no slippage", () => {
    const agg = replayAt(1, [
      [2.0, 30], // a 2x of the alert price inside the first half-minute counts
      [1.5, 600],
    ]);
    expect(agg.entryAt).toEqual(new Date(T0.getTime() + 30_000));
    expect(agg.signalPriceUsd).toBe(1);
    expect(agg.anchorPriceUsd).toBe(1);
    expect(computeOutcomeLabels(agg).hit2xIn1h).toBe(true);
  });

  it("keeps the base at the alert price when the first price is higher or lower", () => {
    expect(replayAt(1, [[1.3, 65]]).anchorPriceUsd).toBe(1);
    expect(replayAt(1, [[0.8, 61]]).anchorPriceUsd).toBe(1);
    // 2.4 is a 2x of the alert price even though the first price seen was 1.3.
    const won = computeOutcomeLabels(
      replayAt(1, [
        [1.3, 65],
        [2.4, 900],
      ]),
    );
    expect(won.hit2xIn1h).toBe(true);
  });

  it("never opens a row after the win window - an outage's first price is not an entry", () => {
    const agg = replayAt(1, [[1.1, 16 * 60]]);
    expect(agg.entryAt).toBeNull();
    expect(agg.anchorPriceUsd).toBe(1);
  });

  it("measures the stop from the alert price", () => {
    const labels = computeOutcomeLabels(
      replayAt(1, [
        [1.0, 61],
        [0.5, 300], // half the alert price
        [2.5, 840],
      ]),
    );
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });
});

describe("runWeight", () => {
  it("weighs a loss and a plain 2x as one row, and a winner more the further it ran", () => {
    expect(runWeight({ labelValue: 0, runPeakMultiple: 50 })).toBe(1);
    expect(runWeight({ labelValue: 1 })).toBe(1);
    expect(runWeight({ labelValue: 2 })).toBeCloseTo(1 + RUN_WEIGHT_PER_DOUBLING, 9);
    // The 24h run peak counts when it is further than the label window's peak.
    expect(runWeight({ labelValue: 1, runPeakMultiple: 16 })).toBeCloseTo(1 + 3 * RUN_WEIGHT_PER_DOUBLING, 9);
    expect(runWeight({ labelValue: 2, runPeakMultiple: 1.5 })).toBeCloseTo(1 + RUN_WEIGHT_PER_DOUBLING, 9);
  });

  it("caps the run at the label cap and turns off at 0", () => {
    expect(runDoublings({ labelValue: 1, runPeakMultiple: 10_000 })).toBeCloseTo(LABEL_LOG2_CAP, 9);
    expect(runWeight({ labelValue: 3, runPeakMultiple: 64 }, 0)).toBe(1);
  });

  it("counts a late runner's run for the score but not for the weight, like the live record", () => {
    // Held above the stop and doubled after the window: run size 2 doublings (a 4x)...
    expect(runDoublings({ labelValue: 0, survived: true, runPeakMultiple: 4 })).toBeCloseTo(2, 9);
    // ...but it is a loss under the label, so it trains at one row.
    expect(runWeight({ labelValue: 0, runPeakMultiple: 4 })).toBe(1);
    // Fell through the stop first, or never reached 2x: nothing.
    expect(runDoublings({ labelValue: 0, survived: false, runPeakMultiple: 4 })).toBe(0);
    expect(runDoublings({ labelValue: 0, runPeakMultiple: 4 })).toBe(0);
    expect(runDoublings({ labelValue: 0, survived: true, runPeakMultiple: 1.9 })).toBe(0);
  });
});
