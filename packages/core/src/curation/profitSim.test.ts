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

describe("simulateExitPlan (half at 2x, rest at 4x, stop -50%, out at 1h)", () => {
  it("a 4x sells both halves on the ladder", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 5, peak1hPriceUsd: 5 }), 0.1, 0)).toBeCloseTo(200);
  });

  it("a double that then falls to the stop sells the rest at the stop", () => {
    const r = row({ peakBeforeStopPriceUsd: 2.5, peak1hPriceUsd: 2.5, low1hPriceUsd: 0.4, stoppedAt: at });
    expect(simulateExitPlan(r, 0.3, 0)).toBeCloseTo(25);
  });

  it("a double that holds closes the rest at the hour's price", () => {
    const r = row({ peakBeforeStopPriceUsd: 3, peak1hPriceUsd: 3 });
    expect(simulateExitPlan(r, 1.6, 0)).toBeCloseTo(80); // 0.5*2 + 0.5*1.6 = 1.8
  });

  it("a stop before the double loses half, whatever it did later", () => {
    // The peak before the stop froze below 2x; the 1h peak after the stop doesn't count.
    const r = row({ peakBeforeStopPriceUsd: 1.3, peak1hPriceUsd: 4, low1hPriceUsd: 0.45, stoppedAt: at });
    expect(simulateExitPlan(r, 3.5, 0)).toBeCloseTo(-50);
  });

  it("a miss that never stopped closes at the hour", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.5, low1hPriceUsd: 0.7 }), 1.2, 0)).toBeCloseTo(
      20,
    );
    expect(simulateExitPlan(row({ low1hPriceUsd: 0.6 }), 0.7, 0)).toBeCloseTo(-30);
  });

  it("charges the exit slippage on every sale", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 5 }), null, 0.03)).toBeCloseTo(
      (3 * 0.97 - 1) * 100,
    );
  });

  it("is unknown without a close price only when part of the position was still held", () => {
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 1.4 }), null, 0)).toBeNull();
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 4 }), null, 0)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ stoppedAt: at, low1hPriceUsd: 0.5 }), null, 0)).toBeCloseTo(-50);
  });

  it("judges older rows without the pre-stop peak off the window's peak and low", () => {
    const r = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 2.2, low1hPriceUsd: 0.9 });
    expect(simulateExitPlan(r, 1, 0)).toBeCloseTo(50);
    const stopped = row({ peakBeforeStopPriceUsd: null, peak1hPriceUsd: 1.2, low1hPriceUsd: 0.5 });
    expect(simulateExitPlan(stopped, 1.1, 0)).toBeCloseTo(-50);
  });

  it("follows a changed ladder", () => {
    const plan = { ...EXIT_PLAN, takeProfits: [{ multiple: 3, sellFraction: 1 }] };
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 3.2 }), 1, 0, plan)).toBeCloseTo(200);
    expect(simulateExitPlan(row({ peakBeforeStopPriceUsd: 2.9 }), 1.5, 0, plan)).toBeCloseTo(50);
  });

  it("refuses a row with no usable fill", () => {
    expect(simulateExitPlan(row({ anchorPriceUsd: 0 }), 1, 0)).toBeNull();
  });
});

describe("describeExitPlan", () => {
  it("reads the default plan as a sentence", () => {
    expect(describeExitPlan()).toBe(
      "Buy at the realistic fill, sell half at 2x, sell the rest at 4x, stop out at -50%, and close whatever is left at 1 hour. Sales pay the same slippage as the buy.",
    );
  });
});
