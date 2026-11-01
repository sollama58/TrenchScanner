import { describe, expect, it } from "vitest";
import { describeFdsaPlan, fdsaRateText, fdsaSignedPct, fdsaSignedSol, fdsaSol } from "./fdsaView";

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
