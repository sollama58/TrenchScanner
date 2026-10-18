import { describe, expect, it } from "vitest";
import type { ExitPlanView } from "./api";
import { exitPlanExamples, exitPlanShort, exitPlanSteps, trailedReturnPct } from "./exitPlan";

/** GET /config/exit-plan for today's plan (exitPlanView() in packages/core, whose own test pins it). */
const PLAN: ExitPlanView = {
  summary: "Enter at the alert price, ...",
  takeProfits: [
    { multiple: 2, sellPct: 35 },
    { multiple: 4, sellPct: 30 },
    { multiple: 10, sellPct: 25 },
  ],
  trail: [{ fromMultiple: 2, offHighPct: 40 }],
  trailMaxHoldMinutes: 180,
  stopPct: 50,
  maxHoldMinutes: 30,
};

describe("exit plan wording", () => {
  it("reads the plan in one line", () => {
    expect(exitPlanShort(PLAN)).toBe(
      "35% sold at 2x, 30% at 4x, 25% at 10x, the rest on a trailing stop 40% off its high, stop at −50%",
    );
  });

  it("lists every step with the plan's own numbers", () => {
    const steps = exitPlanSteps(PLAN);
    expect(steps.map((s) => s.title)).toEqual([
      "Buy at the alert price",
      "Take profit on the way up",
      "Ride the rest on a trailing stop",
      "Stop at −50%",
      "Close at 30 minutes",
    ]);
    expect(steps[1]!.body).toContain("35% at 2x, 30% at 4x and 25% at 10x");
    expect(steps[2]!.body).toContain("40% below its high");
    expect(steps[2]!.body).toContain("3 hours");
  });

  it("follows a changed plan", () => {
    const plan = { ...PLAN, takeProfits: [{ multiple: 3, sellPct: 50 }], stopPct: 40 };
    expect(exitPlanShort(plan)).toBe(
      "50% sold at 3x, the rest on a trailing stop 40% off its high, stop at −40%",
    );
  });
});

describe("worked examples", () => {
  it("works a run and a fall back through the ladder and the trail", () => {
    // 35% at 2x, 30% at 4x, the 35% still held trails out at 3x: 0.7 + 1.2 + 1.05 = 2.95x.
    expect(trailedReturnPct(PLAN, 5)).toBe(195);
    // 35% at 2x, 65% trails out at 1.2x: 0.7 + 0.78 = 1.48x.
    expect(trailedReturnPct(PLAN, 2)).toBe(48);
    expect(trailedReturnPct(PLAN, 1.5)).toBeNull();
    expect(exitPlanExamples(PLAN).map((e) => e.returnPct)).toEqual([195, 48, -50, 20]);
  });
});
