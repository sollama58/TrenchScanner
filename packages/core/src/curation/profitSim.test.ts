import { describe, expect, it } from "vitest";
import {
  EXIT_PLAN,
  applyTrailTick,
  describeExitPlan,
  exitPlanPositionOpen,
  simulateExitPlan,
  trailLevelPriceUsd,
  type ExitPlan,
  type SimulationInput,
} from "./profitSim.js";

const ENTRY = 1;
function row(over: Partial<SimulationInput> = {}): SimulationInput {
  return {
    anchorPriceUsd: ENTRY,
    peak1hPriceUsd: ENTRY,
    low1hPriceUsd: ENTRY,
    peakBeforeStopPriceUsd: ENTRY,
    stoppedAt: null,
    trailHighPriceUsd: null,
    trailExitAt: null,
    trailExitPriceUsd: null,
    ...over,
  };
}
const at = new Date("2026-10-07T00:30:00Z");
const later = new Date("2026-10-07T01:00:00Z");

/** The plan this one replaced: half at 2x, the rest at 4x, everything closed at the window. */
const LADDER_PLAN: ExitPlan = {
  ...EXIT_PLAN,
  takeProfits: [
    { multiple: 2, sellFraction: 0.5 },
    { multiple: 4, sellFraction: 0.5 },
  ],
  trail: [],
};

describe("simulateExitPlan (half at 2x, rest trails 35% off its high, stop -50% before the sale)", () => {
  it("a stop before the sale loses half, whatever it did later", () => {
    // The peak before the stop froze below 2x; the 1h peak after the stop doesn't count.
    const r = row({ peakBeforeStopPriceUsd: 1.3, peak1hPriceUsd: 4, low1hPriceUsd: 0.45, stoppedAt: at });
    expect(simulateExitPlan(r, 3.5)).toBeCloseTo(-50);
  });

  it("a miss that never stopped closes at the window", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5, low1hPriceUsd: 0.7 }), 1.2)).toBeCloseTo(20);
    expect(simulateExitPlan(row({ low1hPriceUsd: 0.6 }), 0.7)).toBeCloseTo(-30);
  });

  it("a sale whose trail has fired pays half at 2x and the rest at the trail's level", () => {
    const r = row({
      peakBeforeStopPriceUsd: 3,
      peak1hPriceUsd: 3,
      trailHighPriceUsd: 5,
      trailExitAt: later,
      trailExitPriceUsd: 3.25,
    });
    expect(simulateExitPlan(r, 2.4)).toBeCloseTo((0.5 * 2 + 0.5 * 3.25 - 1) * 100); // +162.5
    // A double that fell straight back: the trail from a 2x high sits at 1.3x.
    const back = row({
      peakBeforeStopPriceUsd: 2,
      peak1hPriceUsd: 2,
      trailHighPriceUsd: 2,
      trailExitAt: at,
      trailExitPriceUsd: 1.3,
    });
    expect(simulateExitPlan(back, 1.1)).toBeCloseTo(65);
  });

  it("a sale whose trail is still open has no return yet, then closes at the hold cap's price", () => {
    const r = row({ peakBeforeStopPriceUsd: 3, peak1hPriceUsd: 3, trailHighPriceUsd: 3 });
    expect(simulateExitPlan(r, 2.5)).toBeNull();
    expect(exitPlanPositionOpen({ ...r, simReturnPct: null })).toBe(true);
    expect(exitPlanPositionOpen({ ...r, simReturnPct: 12 })).toBe(false);
    expect(simulateExitPlan(r, 2.5, EXIT_PLAN, 2.8)).toBeCloseTo((1 + 0.5 * 2.8 - 1) * 100);
  });

  it("a double after the stop is not a sale: the stop sold everything", () => {
    const r = row({ peakBeforeStopPriceUsd: 1.4, peak1hPriceUsd: 2.5, low1hPriceUsd: 0.4, stoppedAt: at });
    expect(simulateExitPlan(r, 2.5)).toBeCloseTo(-50);
    expect(exitPlanPositionOpen({ ...r, simReturnPct: null })).toBe(false);
  });

  it("a close through the stop fills at the stop, not below it", () => {
    // The closing tick is the first past the window; the window's aggregates never folded it in.
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.4, low1hPriceUsd: 0.8 }), 0.01)).toBeCloseTo(-50);
  });

  it("a close through the first rung is the sale, and the trail is then still open", () => {
    const r = row({ peakBeforeStopPriceUsd: 1.5, trailHighPriceUsd: 2.2 });
    expect(simulateExitPlan(r, 2.2)).toBeNull();
    expect(exitPlanPositionOpen({ ...r, simReturnPct: null })).toBe(true);
    expect(simulateExitPlan(r, 2.2, EXIT_PLAN, 1.9)).toBeCloseTo((1 + 0.5 * 1.9 - 1) * 100);
  });

  it("judges older rows without the pre-stop peak off the window's peak and low", () => {
    const stopped = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 1.2, low1hPriceUsd: 0.5 });
    expect(simulateExitPlan(stopped, 1.1)).toBeCloseTo(-50);
    const sold = row({
      peakBeforeStopPriceUsd: null,
      peak1hPriceUsd: 2.2,
      low1hPriceUsd: 0.9,
      trailHighPriceUsd: 2.2,
      trailExitAt: at,
      trailExitPriceUsd: 1.43,
    });
    expect(simulateExitPlan(sold, 1)).toBeCloseTo((1 + 0.5 * 1.43 - 1) * 100);
  });

  it("refuses a row with no usable alert price", () => {
    expect(simulateExitPlan(row({ anchorPriceUsd: 0 }), 1)).toBeNull();
  });
});

describe("simulateExitPlan under a ladder with no trail (the plan before 2026-10-07)", () => {
  it("sells both halves on the ladder and closes the rest at the window", () => {
    expect(
      simulateExitPlan(row({ peakBeforeStopPriceUsd: 5, peak1hPriceUsd: 5 }), 0.1, LADDER_PLAN),
    ).toBeCloseTo(200);
    expect(
      simulateExitPlan(row({ peakBeforeStopPriceUsd: 3, peak1hPriceUsd: 3 }), 1.6, LADDER_PLAN),
    ).toBeCloseTo(80);
    const stopped = row({
      peakBeforeStopPriceUsd: 2.5,
      peak1hPriceUsd: 2.5,
      low1hPriceUsd: 0.4,
      stoppedAt: at,
    });
    expect(simulateExitPlan(stopped, 0.3, LADDER_PLAN)).toBeCloseTo(25);
  });

  it("is unknown without a close price only when part of the position was still held", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.4 }), null, LADDER_PLAN)).toBeNull();
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 4 }), null, LADDER_PLAN)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ stoppedAt: at, low1hPriceUsd: 0.5 }), null, LADDER_PLAN)).toBeCloseTo(-50);
  });

  it("a close through a take-profit fills that rung, not above it", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5 }), 4.5, LADDER_PLAN)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5 }), 2.2, LADDER_PLAN)).toBeCloseTo(110);
    expect(
      exitPlanPositionOpen({ ...row({ peakBeforeStopPriceUsd: 3 }), simReturnPct: null }, LADDER_PLAN),
    ).toBe(false);
  });
});

describe("applyTrailTick", () => {
  const state = (over: Partial<SimulationInput> = {}) => row(over);

  it("arms at the first rung, with that price as the high, and not after the stop", () => {
    expect(applyTrailTick(state(), 1.9, at)).toEqual({});
    expect(applyTrailTick(state(), 2.1, at)).toEqual({ trailHighPriceUsd: 2.1 });
    expect(applyTrailTick(state({ stoppedAt: at }), 2.1, later)).toEqual({});
  });

  it("lifts the high, and fires at the level the high sets", () => {
    expect(applyTrailTick(state({ trailHighPriceUsd: 2.1 }), 3, at)).toEqual({ trailHighPriceUsd: 3 });
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 2.1, at)).toEqual({});
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 1.9, later)).toEqual({
      trailExitAt: later,
      trailExitPriceUsd: 3 * 0.65,
    });
  });

  it("moves nothing once the exit has fired, and ignores a bad price", () => {
    const fired = state({ trailHighPriceUsd: 3, trailExitAt: at, trailExitPriceUsd: 1.95 });
    expect(applyTrailTick(fired, 9, later)).toEqual({});
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 0, later)).toEqual({});
  });

  it("follows a ratchet: the tier the high has reached sets the level", () => {
    const plan: ExitPlan = {
      ...EXIT_PLAN,
      trail: [
        { fromMultiple: 2, fraction: 0.5 },
        { fromMultiple: 4, fraction: 0.35 },
        { fromMultiple: 10, fraction: 0.25 },
      ],
    };
    expect(trailLevelPriceUsd(1, 2.5, plan)).toBeCloseTo(1.25);
    expect(trailLevelPriceUsd(1, 5, plan)).toBeCloseTo(3.25);
    expect(trailLevelPriceUsd(1, 12, plan)).toBeCloseTo(9);
    expect(applyTrailTick(state({ trailHighPriceUsd: 12 }), 9.2, at, plan)).toEqual({});
    expect(applyTrailTick(state({ trailHighPriceUsd: 12 }), 8.9, at, plan)).toEqual({
      trailExitAt: at,
      trailExitPriceUsd: 9,
    });
  });
});

describe("describeExitPlan", () => {
  it("reads the default plan as a sentence", () => {
    expect(describeExitPlan()).toBe(
      "Buy at the alert price, sell half at 2x, let the rest ride with a trailing exit 35% off its high, out at 3 hours, " +
        "stop out at -50% before the first sale, and close a call that never sold at 30 minutes.",
    );
  });

  it("reads a ladder with no trail the old way", () => {
    expect(describeExitPlan(LADDER_PLAN)).toBe(
      "Buy at the alert price, sell half at 2x, sell the rest at 4x, stop out at -50%, and close whatever is left at 30 minutes.",
    );
  });
});
