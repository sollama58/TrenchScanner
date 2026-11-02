import { describe, expect, it } from "vitest";
import {
  describeFdsaPlan,
  fdsaMeasuredText,
  fdsaAxisTop,
  fdsaBankedMultiple,
  fdsaCheckInText,
  fdsaExitReasonText,
  fdsaHeld,
  fdsaLogPos,
  fdsaMultiple,
  fdsaRateText,
  fdsaSignedPct,
  fdsaSignedSol,
  fdsaSol,
} from "./fdsaView";

describe("FDSA tab formatting", () => {
  it("describes a plan in words", () => {
    expect(
      describeFdsaPlan({
        stopMultiple: 0.5,
        lockIns: [{ atMultiple: 2, floorMultiple: 1 }],
        trail: [
          { fromMultiple: 2, fraction: 0.4 },
          { fromMultiple: 4, fraction: 0.3 },
        ],
        partials: [{ atMultiple: 2, sellFraction: 0.25 }],
        maxHoldMinutes: 180,
        stall: { afterMinutes: 30, belowMultiple: 1.2 },
      }),
    ).toBe(
      "Stop -50%; floor 1x from 2x; trail 40% from 2x, 30% from 4x; sell 25% at 2x; out after 30m if under 1.2x; out by 3h.",
    );
    expect(
      describeFdsaPlan({
        stopMultiple: 1.5,
        lockIns: [],
        trail: [],
        partials: [],
        maxHoldMinutes: 45,
        stall: null,
      }),
    ).toBe("Stop at 1.5x; no partial sells; out by 45m.");
  });

  it("shows a rate with its sample, and says when nothing is graded", () => {
    expect(fdsaRateText({ total: 6, graded: 5, wins: 2, rate: 0.4, wins4x: 0 })).toBe("40% (2/5)");
    expect(fdsaRateText({ total: 3, graded: 0, wins: 0, rate: null, wins4x: 0 })).toBe("– (0 graded)");
  });

  it("states the measured band with its 90% range", () => {
    expect(fdsaMeasuredText({ total: 60, graded: 50, wins: 12, rate: 0.24, wins4x: 0 })).toBe(
      "24% (90% range 16-35%, 12 of 50)",
    );
    expect(fdsaMeasuredText({ total: 3, graded: 0, wins: 0, rate: null, wins4x: 0 })).toBe(
      "no graded buys yet",
    );
  });

  it("signs SOL and percent", () => {
    expect(fdsaSol("10000000000", 2)).toBe("10.00 SOL");
    expect(fdsaSol(null)).toBe("–");
    expect(fdsaSignedSol("-250000000")).toBe("−0.2500 SOL");
    expect(fdsaSignedSol("500000000")).toBe("+0.5000 SOL");
    expect(fdsaSignedPct(12.345)).toBe("+12.3%");
    expect(fdsaSignedPct(-50)).toBe("−50.0%");
    expect(fdsaSignedPct(null)).toBe("–");
  });
});

describe("FDSA page formatting", () => {
  it("names exits and check-ins in words", () => {
    expect(fdsaExitReasonText("floor")).toBe("Fell to its locked-in floor");
    expect(fdsaExitReasonText("new_reason")).toBe("new reason");
    expect(fdsaExitReasonText(null)).toBe("–");
    expect(fdsaCheckInText("crossed_2x")).toBe("Crossed 2x");
    expect(fdsaCheckInText("drawdown@3.1")).toBe("Sharp drop from the high");
  });

  it("formats multiples, holds and what a trade banked", () => {
    expect(fdsaMultiple(2.4)).toBe("2.40x");
    expect(fdsaMultiple(12.34)).toBe("12.3x");
    expect(fdsaMultiple(null)).toBe("–");
    expect(fdsaBankedMultiple(140)).toBeCloseTo(2.4);
    expect(fdsaBankedMultiple(null)).toBeNull();
    expect(fdsaHeld(45_000)).toBe("45s");
    expect(fdsaHeld(12 * 60_000)).toBe("12m");
    expect(fdsaHeld(125 * 60_000)).toBe("2h 5m");
    expect(fdsaHeld(120 * 60_000)).toBe("2h");
  });

  it("places multiples on a log axis that fits the biggest run", () => {
    expect(fdsaLogPos(1, 0.5, 2)).toBeCloseTo(0.5);
    expect(fdsaLogPos(0.1, 0.5, 2)).toBe(0);
    expect(fdsaLogPos(9, 0.5, 2)).toBe(1);
    expect(fdsaAxisTop([1.2, 1.5])).toBe(2);
    expect(fdsaAxisTop([3.5])).toBe(4);
    expect(fdsaAxisTop([7, null])).toBe(10);
    expect(fdsaAxisTop([140])).toBe(200);
    expect(fdsaAxisTop([])).toBe(2);
  });
});
