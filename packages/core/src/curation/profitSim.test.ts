import { describe, expect, it } from "vitest";
import { EXIT_PLAN, describeExitPlan, simulateExitPlan, type SimulationInput } from "./profitSim.js";

const ENTRY = 1;
function row(over: Partial<SimulationInput> = {}): SimulationInput {
  return {
    anchorPriceUsd: ENTRY,
    peak1hPriceUsd: ENTRY,
    low1hPriceUsd: ENTRY,
    peakBeforeStopPriceUsd: ENTRY,
    stoppedAt: null,
    ...over,
  };
}
const at = new Date("2026-10-05T00:30:00Z");

describe("simulateExitPlan (half at 2x, rest at 4x, stop -50%, out at 30 min)", () => {
  it("a 4x sells both halves on the ladder", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 5, peak1hPriceUsd: 5 }), 0.1)).toBeCloseTo(200);
  });

  it("a double that then falls to the stop sells the rest at the stop", () => {
    const r = row({ peakBeforeStopPriceUsd: 2.5, peak1hPriceUsd: 2.5, low1hPriceUsd: 0.4, stoppedAt: at });
    expect(simulateExitPlan(r, 0.3)).toBeCloseTo(25);
  });

  it("a double that holds closes the rest at the hour's price", () => {
    const r = row({ peakBeforeStopPriceUsd: 3, peak1hPriceUsd: 3 });
    expect(simulateExitPlan(r, 1.6)).toBeCloseTo(80); // 0.5*2 + 0.5*1.6 = 1.8
  });

  it("a stop before the double loses half, whatever it did later", () => {
    // The peak before the stop froze below 2x; the 1h peak after the stop doesn't count.
    const r = row({ peakBeforeStopPriceUsd: 1.3, peak1hPriceUsd: 4, low1hPriceUsd: 0.45, stoppedAt: at });
    expect(simulateExitPlan(r, 3.5)).toBeCloseTo(-50);
  });

  it("a miss that never stopped closes at the hour", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5, low1hPriceUsd: 0.7 }), 1.2)).toBeCloseTo(20);
    expect(simulateExitPlan(row({ low1hPriceUsd: 0.6 }), 0.7)).toBeCloseTo(-30);
  });

  it("a close through the stop fills at the stop, not below it", () => {
    // The closing tick is the first past the window; the window's aggregates never folded it in.
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.4, low1hPriceUsd: 0.8 }), 0.01)).toBeCloseTo(-50);
    const doubled = row({ peakBeforeStopPriceUsd: 2.5, peak1hPriceUsd: 2.5, low1hPriceUsd: 0.9 });
    expect(simulateExitPlan(doubled, 0.3)).toBeCloseTo(25);
    expect(simulateExitPlan(doubled, 0.5)).toBeCloseTo(25);
  });

  it("a close through a take-profit fills that rung, not above it", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5 }), 4.5)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5 }), 2.2)).toBeCloseTo(110); // 0.5*2 + 0.5*2.2
    const older = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 3, low1hPriceUsd: 0.9 });
    expect(simulateExitPlan(older, 5)).toBeCloseTo(200);
  });

  it("is unknown without a close price only when part of the position was still held", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.4 }), null)).toBeNull();
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 4 }), null)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ stoppedAt: at, low1hPriceUsd: 0.5 }), null)).toBeCloseTo(-50);
  });

  it("judges older rows without the pre-stop peak off the window's peak and low", () => {
    const r = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 2.2, low1hPriceUsd: 0.9 });
    expect(simulateExitPlan(r, 1)).toBeCloseTo(50);
    const stopped = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 1.2, low1hPriceUsd: 0.5 });
    expect(simulateExitPlan(stopped, 1.1)).toBeCloseTo(-50);
  });

  it("follows a changed ladder", () => {
    const plan = { ...EXIT_PLAN, takeProfits: [{ multiple: 3, sellFraction: 1 }] };
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 3.2 }), 1, plan)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 2.9 }), 1.5, plan)).toBeCloseTo(50);
  });

  it("refuses a row with no usable alert price", () => {
    expect(simulateExitPlan(row({ anchorPriceUsd: 0 }), 1)).toBeNull();
  });
});

describe("describeExitPlan", () => {
  it("reads the default plan as a sentence", () => {
    expect(describeExitPlan()).toBe(
      "Buy at the alert price, sell half at 2x, sell the rest at 4x, stop out at -50%, and close whatever is left at 30 minutes.",
    );
  });
});
