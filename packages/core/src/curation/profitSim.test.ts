import { describe, expect, it } from "vitest";
import {
  EXIT_PLAN,
  applyTrailTick,
  describeExitPlan,
  exitPlanView,
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

/** The plan before 2026-10-17: half at 2x, the rest trailing 35% off its high. */
const TRAIL_PLAN: ExitPlan = {
  ...EXIT_PLAN,
  takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
  trail: [{ fromMultiple: 2, fraction: 0.35 }],
};
const sim07 = (
  r: SimulationInput,
  close: number | null,
  plan: ExitPlan = TRAIL_PLAN,
  cap: number | null = null,
) => simulateExitPlan(r, close, plan, cap);

describe("simulateExitPlan under the default plan (35% at 2x, 30% at 4x, 25% at 10x, trail 40% from 2x)", () => {
  it("doesn't sell the 4x rung on a run that came after the trail fired", () => {
    // 2x, trail fires at 1.15x, then the coin runs to 5x and closes at 4.5x: too late for 4x.
    const late = row({
      peakBeforeStopPriceUsd: 5,
      peak1hPriceUsd: 5,
      trailHighPriceUsd: 2,
      trailExitAt: at,
      trailExitPriceUsd: 1.15,
    });
    expect(simulateExitPlan(late, 4.5)).toBeCloseTo((0.35 * 2 + 0.65 * 1.15 - 1) * 100, 6);
  });

  it("reaches 4x, then falls 40% off its high before 10x", () => {
    // 35% at 2x, 30% at 4x, the last 35% out at 5 x 0.6 = 3x.
    const r = row({
      peakBeforeStopPriceUsd: 5,
      peak1hPriceUsd: 5,
      trailHighPriceUsd: 5,
      trailExitAt: at,
      trailExitPriceUsd: 3,
    });
    expect(simulateExitPlan(r, 3)).toBeCloseTo((0.35 * 2 + 0.3 * 4 + 0.35 * 3 - 1) * 100, 6);
  });

  it("closes what the trail holds at the 3-hour cap", () => {
    const r = row({ peakBeforeStopPriceUsd: 4.5, peak1hPriceUsd: 4.5, trailHighPriceUsd: 4.5 });
    expect(simulateExitPlan(r, 4)).toBeNull();
    expect(exitPlanPositionOpen(r)).toBe(true);
    expect(simulateExitPlan(r, 4, EXIT_PLAN, 3.5)).toBeCloseTo(
      (0.35 * 2 + 0.3 * 4 + 0.35 * 3.5 - 1) * 100,
      6,
    );
  });

  it("closes a call that never sold at the window's close", () => {
    const r = row({ peakBeforeStopPriceUsd: 1.6, peak1hPriceUsd: 1.6, low1hPriceUsd: 0.8 });
    expect(exitPlanPositionOpen(r)).toBe(false);
    expect(simulateExitPlan(r, 1.3)).toBeCloseTo(30, 6);
  });

  it("a call that doubled and fell straight back still makes money", () => {
    // Trail from a 2x high sits at 1.2x: 0.35 x 2 + 0.65 x 1.2 = 1.48x.
    const back = row({
      peakBeforeStopPriceUsd: 2,
      peak1hPriceUsd: 2,
      trailHighPriceUsd: 2,
      trailExitAt: at,
      trailExitPriceUsd: 1.2,
    });
    expect(simulateExitPlan(back, 1.1)).toBeCloseTo(48);
  });

  it("sells the 4x rung when the trail's high reached it, and trails the rest", () => {
    // High 5x: 35% at 2x, 30% at 4x, the 35% left out at the 3x the trail sold at.
    const r = row({
      peakBeforeStopPriceUsd: 3,
      peak1hPriceUsd: 3,
      trailHighPriceUsd: 5,
      trailExitAt: later,
      trailExitPriceUsd: 3,
    });
    expect(simulateExitPlan(r, 2.5)).toBeCloseTo((0.35 * 2 + 0.3 * 4 + 0.35 * 3 - 1) * 100); // +195
  });

  it("sells all three rungs on a 10x and trails the last tenth", () => {
    const r = row({
      peakBeforeStopPriceUsd: 4,
      peak1hPriceUsd: 4,
      trailHighPriceUsd: 12,
      trailExitAt: later,
      trailExitPriceUsd: 7.2,
    });
    expect(simulateExitPlan(r, 3)).toBeCloseTo((0.35 * 2 + 0.3 * 4 + 0.25 * 10 + 0.1 * 7.2 - 1) * 100);
  });

  it("still stops out at -50% before the first sale", () => {
    const r = row({ peakBeforeStopPriceUsd: 1.6, peak1hPriceUsd: 3, low1hPriceUsd: 0.4, stoppedAt: at });
    expect(simulateExitPlan(r, 2)).toBeCloseTo(-50);
  });

  it("trails 40% off the high", () => {
    expect(trailLevelPriceUsd(1, 5)).toBeCloseTo(3);
    expect(applyTrailTick(row({ trailHighPriceUsd: 5 }), 3.05, at)).toEqual({});
    expect(applyTrailTick(row({ trailHighPriceUsd: 5 }), 2.9, at)).toEqual({
      trailExitAt: at,
      trailExitPriceUsd: 2.9,
    });
  });
});

describe("simulateExitPlan under the 2026-10-07 plan (half at 2x, rest trails 35% off its high, stop -50% before the sale)", () => {
  it("a stop before the sale loses half, whatever it did later", () => {
    // The peak before the stop froze below 2x; the 1h peak after the stop doesn't count.
    const r = row({ peakBeforeStopPriceUsd: 1.3, peak1hPriceUsd: 4, low1hPriceUsd: 0.45, stoppedAt: at });
    expect(sim07(r, 3.5)).toBeCloseTo(-50);
  });

  it("a miss that never stopped closes at the window", () => {
    expect(sim07(row({ peakBeforeStopPriceUsd: 1.5, low1hPriceUsd: 0.7 }), 1.2)).toBeCloseTo(20);
    expect(sim07(row({ low1hPriceUsd: 0.6 }), 0.7)).toBeCloseTo(-30);
  });

  it("a sale whose trail has fired pays half at 2x and the rest at the price the trail sold at", () => {
    const r = row({
      peakBeforeStopPriceUsd: 3,
      peak1hPriceUsd: 3,
      trailHighPriceUsd: 5,
      trailExitAt: later,
      trailExitPriceUsd: 3.25,
    });
    expect(sim07(r, 2.4)).toBeCloseTo((0.5 * 2 + 0.5 * 3.25 - 1) * 100); // +162.5
    // A double that fell straight back: the trail from a 2x high sits at 1.3x.
    const back = row({
      peakBeforeStopPriceUsd: 2,
      peak1hPriceUsd: 2,
      trailHighPriceUsd: 2,
      trailExitAt: at,
      trailExitPriceUsd: 1.3,
    });
    expect(sim07(back, 1.1)).toBeCloseTo(65);
  });

  it("a sale whose trail is still open has no return yet, then closes at the hold cap's price", () => {
    const r = row({ peakBeforeStopPriceUsd: 3, peak1hPriceUsd: 3, trailHighPriceUsd: 3 });
    expect(sim07(r, 2.5)).toBeNull();
    expect(exitPlanPositionOpen({ ...r, simReturnPct: null }, TRAIL_PLAN)).toBe(true);
    expect(exitPlanPositionOpen({ ...r, simReturnPct: 12 }, TRAIL_PLAN)).toBe(false);
    expect(sim07(r, 2.5, TRAIL_PLAN, 2.8)).toBeCloseTo((1 + 0.5 * 2.8 - 1) * 100);
  });

  it("a double after the stop is not a sale: the stop sold everything", () => {
    const r = row({ peakBeforeStopPriceUsd: 1.4, peak1hPriceUsd: 2.5, low1hPriceUsd: 0.4, stoppedAt: at });
    expect(sim07(r, 2.5)).toBeCloseTo(-50);
    expect(exitPlanPositionOpen({ ...r, simReturnPct: null }, TRAIL_PLAN)).toBe(false);
  });

  it("a close through the stop fills at the stop, not below it", () => {
    // The closing tick is the first past the window; the window's aggregates never folded it in.
    expect(sim07(row({ peakBeforeStopPriceUsd: 1.4, low1hPriceUsd: 0.8 }), 0.01)).toBeCloseTo(-50);
  });

  it("a close through the first rung is the sale, and the trail is then still open", () => {
    const r = row({ peakBeforeStopPriceUsd: 1.5, trailHighPriceUsd: 2.2 });
    expect(sim07(r, 2.2)).toBeNull();
    expect(exitPlanPositionOpen({ ...r, simReturnPct: null }, TRAIL_PLAN)).toBe(true);
    expect(sim07(r, 2.2, TRAIL_PLAN, 1.9)).toBeCloseTo((1 + 0.5 * 1.9 - 1) * 100);
  });

  it("judges older rows without the pre-stop peak off the window's peak and low", () => {
    const stopped = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 1.2, low1hPriceUsd: 0.5 });
    expect(sim07(stopped, 1.1)).toBeCloseTo(-50);
    const sold = row({
      peakBeforeStopPriceUsd: null,
      peak1hPriceUsd: 2.2,
      low1hPriceUsd: 0.9,
      trailHighPriceUsd: 2.2,
      trailExitAt: at,
      trailExitPriceUsd: 1.43,
    });
    expect(sim07(sold, 1)).toBeCloseTo((1 + 0.5 * 1.43 - 1) * 100);
  });

  it("refuses a row with no usable alert price", () => {
    expect(sim07(row({ anchorPriceUsd: 0 }), 1)).toBeNull();
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
    expect(applyTrailTick(state(), 1.9, at, TRAIL_PLAN)).toEqual({});
    expect(applyTrailTick(state(), 2.1, at, TRAIL_PLAN)).toEqual({ trailHighPriceUsd: 2.1 });
    expect(applyTrailTick(state({ stoppedAt: at }), 2.1, later, TRAIL_PLAN)).toEqual({});
  });

  it("lifts the high, and fires at or under the level the high sets, at the price seen", () => {
    expect(applyTrailTick(state({ trailHighPriceUsd: 2.1 }), 3, at, TRAIL_PLAN)).toEqual({
      trailHighPriceUsd: 3,
    });
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 2.1, at, TRAIL_PLAN)).toEqual({});
    // A gap through the level books the gap, not the level: a trader with a trailing stop at 1.95
    // whose next print is 1.5 sold at 1.5.
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 1.5, later, TRAIL_PLAN)).toEqual({
      trailExitAt: later,
      trailExitPriceUsd: 1.5,
    });
    // A tick exactly at the level fills at the level.
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 3 * 0.65, later, TRAIL_PLAN)).toEqual({
      trailExitAt: later,
      trailExitPriceUsd: 3 * 0.65,
    });
  });

  it("moves nothing once the exit has fired, and ignores a bad price", () => {
    const fired = state({ trailHighPriceUsd: 3, trailExitAt: at, trailExitPriceUsd: 1.95 });
    expect(applyTrailTick(fired, 9, later)).toEqual({});
    expect(applyTrailTick(state({ trailHighPriceUsd: 3 }), 0, later, TRAIL_PLAN)).toEqual({});
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
      trailExitPriceUsd: 8.9,
    });
  });
});

describe("exitPlanView", () => {
  it("sends the default plan as whole percents, lowest rung first", () => {
    expect(exitPlanView()).toEqual({
      summary: describeExitPlan(),
      takeProfits: [
        { multiple: 2, sellPct: 35 },
        { multiple: 4, sellPct: 30 },
        { multiple: 10, sellPct: 25 },
      ],
      trail: [{ fromMultiple: 2, offHighPct: 40 }],
      trailMaxHoldMinutes: 180,
      stopPct: 50,
      maxHoldMinutes: 30,
    });
  });
});

describe("describeExitPlan", () => {
  it("reads the default plan as a sentence", () => {
    expect(describeExitPlan()).toBe(
      "Enter at the alert price, sell 35% at 2x, sell 30% at 4x, sell 25% at 10x, from the first sale, let what is still " +
        "held ride with a trailing exit 40% off its high, out at 3 hours, stop out at -50% before the first sale, and " +
        "close any position that never sold at 30 minutes.",
    );
    expect(describeExitPlan(TRAIL_PLAN)).toBe(
      "Enter at the alert price, sell half at 2x, let the rest ride with a trailing exit 35% off its high, out at 3 hours, " +
        "stop out at -50% before the first sale, and close any position that never sold at 30 minutes.",
    );
  });

  it("reads a ladder with no trail the old way", () => {
    expect(describeExitPlan(LADDER_PLAN)).toBe(
      "Enter at the alert price, sell half at 2x, sell the rest at 4x, stop out at -50%, and close whatever is left at 30 minutes.",
    );
  });
});
