import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { DISQUALIFYING_DRAWDOWN_FRACTION } from "../curation/labels.js";
import {
  addAiSpend,
  aiSpendLedger,
  aiSpentUsd,
  fdsaSourceSpentUsd,
  fdsaSpendLimitUsd,
  readAiBudget,
  readFdsaBudget,
  summarizeFdsaBudget,
} from "../curation/aiSpend.js";
import { prisma } from "../db.js";
import { DEFAULT_TRADING_BOT_CONFIG } from "../trading/config.js";
import { DEFAULT_PAPER_CONFIG } from "../trading/paper.js";
import { sellAmount } from "../trading/exitEngine.js";
import { decideAdaptiveExit, type FdsaPositionState } from "./adaptiveExit.js";
import {
  applyFdsaRevision,
  clampFdsaExitPlan,
  FDSA_DEFAULT_EXIT_PLAN,
  FDSA_HARD_FLOOR_MULTIPLE,
  FDSA_MAX_HOLD_CAP_MINUTES,
  fdsaExitPlanSchema,
  fdsaFloorMultiple,
  fdsaPartialTarget,
  fdsaRevisionDue,
  readFdsaExitPlanOrHardFloor,
  type FdsaExitPlan,
} from "./exitPlan.js";
import {
  DEFAULT_FDSA_BANKROLL_SOL,
  DEFAULT_FDSA_DESK_CONFIG,
  FDSA_AVAILABLE_MODES,
  readFdsaDeskConfig,
  readFdsaMode,
} from "./desk.js";
import {
  DEFAULT_FDSA_TRADE_MIN_P2X,
  FDSA_PROMPT_VERSION,
  FDSA_PROMPT_VERSIONS,
  fdsaReviewDedupeKey,
  fdsaTradeBarRisk,
  readFdsaDecideAnswer,
  readFdsaReviseAnswer,
  readFdsaScreenAnswer,
} from "./verdicts.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const T0 = new Date("2026-11-01T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ok = { stopReason: "end_turn" };

function state(over: Partial<FdsaPositionState> = {}): FdsaPositionState {
  return {
    openedAt: T0,
    peakMultiple: null,
    floorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
    soldFraction: 0,
    ...over,
  };
}

describe("FDSA hard floor", () => {
  it("is the project's -50% stop", () => {
    expect(FDSA_HARD_FLOOR_MULTIPLE).toBe(DISQUALIFYING_DRAWDOWN_FRACTION);
    expect(FDSA_HARD_FLOOR_MULTIPLE).toBe(0.5);
  });
});

describe("decideAdaptiveExit", () => {
  /** Only the stop, so a test sees one rule at a time. */
  const bare: FdsaExitPlan = {
    stopMultiple: FDSA_HARD_FLOOR_MULTIPLE,
    lockIns: [],
    trail: [],
    partials: [],
    maxHoldMinutes: 180,
    stall: null,
  };

  it("holds above the floor and inside the hold cap", () => {
    const d = decideAdaptiveExit(state(), 0.9, at(5), FDSA_DEFAULT_EXIT_PLAN);
    expect(d).toEqual({ action: "hold", peakMultiple: 0.9, floorMultiple: 0.5 });
  });

  it("sells everything at the -50% stop", () => {
    const d = decideAdaptiveExit(state(), 0.5, at(1), FDSA_DEFAULT_EXIT_PLAN);
    expect(d).toMatchObject({ action: "sell", all: true, fraction: 1, reason: "stop_loss" });
  });

  it("never runs a floor below -50%, whatever the stored floor or plan says", () => {
    const loose: FdsaExitPlan = { ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: 0.1, lockIns: [], trail: [] };
    const d = decideAdaptiveExit(state({ floorMultiple: 0.05 }), 0.45, at(1), loose);
    expect(d).toMatchObject({ action: "sell", reason: "stop_loss", floorMultiple: 0.5 });
    expect(decideAdaptiveExit(state({ floorMultiple: Number.NaN }), 0.49, at(1), loose)).toMatchObject({
      action: "sell",
      floorMultiple: 0.5,
    });
    // Over a sweep of prices and plans, no floor the engine returns is ever under the stop.
    for (const stop of [0.1, 0.5, 0.8]) {
      for (const m of [0, 0.3, 0.5, 0.51, 1, 2.2, 5, 40]) {
        const plan = { ...bare, stopMultiple: stop };
        const out = decideAdaptiveExit(state({ floorMultiple: -3 }), m, at(2), plan);
        expect(out.floorMultiple).toBeGreaterThanOrEqual(FDSA_HARD_FLOOR_MULTIPLE);
        if (m <= 0.5) expect(out.action).toBe("sell");
      }
    }
  });

  it("a tighter plan stop sells sooner", () => {
    const tight = { ...bare, stopMultiple: 0.7 };
    expect(decideAdaptiveExit(state(), 0.69, at(1), tight)).toMatchObject({
      action: "sell",
      reason: "stop_loss",
      floorMultiple: 0.7,
    });
  });

  it("keeps a stored floor that has ratcheted into profit, and calls that exit a floor", () => {
    const d = decideAdaptiveExit(
      state({ floorMultiple: 1.6, peakMultiple: 3, soldFraction: 0.25 }),
      1.5,
      at(20),
      bare,
    );
    expect(d).toMatchObject({
      action: "sell",
      all: true,
      reason: "floor",
      fraction: 0.75,
      floorMultiple: 1.6,
      peakMultiple: 3,
    });
  });

  it("ratchets: a lock-in arms at its level and the trail follows the high, never back down", () => {
    const plan: FdsaExitPlan = {
      ...bare,
      lockIns: [{ atMultiple: 2, floorMultiple: 1 }],
      trail: [
        { fromMultiple: 2, fraction: 0.4 },
        { fromMultiple: 4, fraction: 0.25 },
      ],
    };
    // Under 2x only the stop holds.
    expect(decideAdaptiveExit(state({ peakMultiple: 1.9 }), 1.8, at(2), plan)).toMatchObject({
      action: "hold",
      floorMultiple: 0.5,
    });
    // At 2x: lock-in 1.0, trail 2 x 0.6 = 1.2.
    const at2 = decideAdaptiveExit(state({ peakMultiple: 1.9 }), 2, at(3), plan);
    expect(at2).toMatchObject({ action: "hold", peakMultiple: 2 });
    expect(at2.floorMultiple).toBeCloseTo(1.2);
    // At 5x the tighter tier: 5 x 0.75 = 3.75.
    const at5 = decideAdaptiveExit(state({ peakMultiple: 4.5, floorMultiple: 2.7 }), 5, at(6), plan);
    expect(at5.floorMultiple).toBeCloseTo(3.75);
    // Back to 4x from a 5x peak: still holding (4 > 3.75), floor unchanged.
    const back = decideAdaptiveExit(state({ peakMultiple: 5, floorMultiple: 3.75 }), 4, at(7), plan);
    expect(back).toMatchObject({ action: "hold", peakMultiple: 5 });
    expect(back.floorMultiple).toBeCloseTo(3.75);
    // Through it: a floor exit, in profit, where the ladder would have sold 90% by 10x and capped it.
    expect(
      decideAdaptiveExit(state({ peakMultiple: 5, floorMultiple: 3.75 }), 3.7, at(8), plan),
    ).toMatchObject({
      action: "sell",
      all: true,
      reason: "floor",
    });
  });

  it("a stored floor above what the plan gives now is kept (it never moves down)", () => {
    const d = decideAdaptiveExit(state({ peakMultiple: 3, floorMultiple: 2.5 }), 2.6, at(9), bare);
    expect(d).toMatchObject({ action: "hold", floorMultiple: 2.5 });
  });

  it("sells the plan's partials as cumulative targets, once each", () => {
    const plan: FdsaExitPlan = {
      ...bare,
      partials: [
        { atMultiple: 2, sellFraction: 0.25 },
        { atMultiple: 4, sellFraction: 0.25 },
      ],
    };
    expect(decideAdaptiveExit(state(), 1.9, at(2), plan).action).toBe("hold");
    expect(decideAdaptiveExit(state(), 2.1, at(2), plan)).toMatchObject({
      action: "sell",
      reason: "partial",
      all: false,
      fraction: 0.25,
    });
    // Already sold: nothing more at 2x.
    expect(
      decideAdaptiveExit(state({ soldFraction: 0.25, peakMultiple: 2.1 }), 2.5, at(3), plan).action,
    ).toBe("hold");
    // A jump straight past both levels sells both shares at once.
    expect(decideAdaptiveExit(state(), 4.2, at(3), plan)).toMatchObject({ reason: "partial", fraction: 0.5 });
    // A partial that would leave nothing is a sell-all.
    const whole = { ...bare, partials: [{ atMultiple: 3, sellFraction: 1 }] };
    expect(decideAdaptiveExit(state(), 3, at(3), whole)).toMatchObject({ reason: "partial", all: true });
  });

  it("the floor wins over a partial on the same tick", () => {
    const plan: FdsaExitPlan = {
      ...bare,
      stopMultiple: 2.5,
      partials: [{ atMultiple: 2, sellFraction: 0.5 }],
    };
    expect(decideAdaptiveExit(state({ floorMultiple: 2.5 }), 2.4, at(3), plan)).toMatchObject({
      reason: "floor",
      all: true,
    });
  });

  it("closes a stalled position after its window, and only while it is under the bar", () => {
    const plan = { ...bare, stall: { afterMinutes: 30, belowMultiple: 1.2 } };
    expect(decideAdaptiveExit(state(), 1.1, at(29), plan).action).toBe("hold");
    expect(decideAdaptiveExit(state(), 1.1, at(30), plan)).toMatchObject({ action: "sell", reason: "stall" });
    expect(decideAdaptiveExit(state(), 1.3, at(45), plan).action).toBe("hold");
  });

  it("closes at the plan's hold cap, and at the absolute cap past a plan that says longer", () => {
    expect(decideAdaptiveExit(state(), 1.4, at(180), FDSA_DEFAULT_EXIT_PLAN)).toMatchObject({
      action: "sell",
      reason: "max_hold",
    });
    const long = { ...bare, maxHoldMinutes: 10 * FDSA_MAX_HOLD_CAP_MINUTES };
    expect(decideAdaptiveExit(state(), 1.4, at(FDSA_MAX_HOLD_CAP_MINUTES), long)).toMatchObject({
      reason: "max_hold",
    });
  });

  it("tracks the peak and holds on a price that isn't a number", () => {
    expect(decideAdaptiveExit(state({ peakMultiple: 2.5 }), 1.2, at(3), bare)).toMatchObject({
      action: "hold",
      peakMultiple: 2.5,
    });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(decideAdaptiveExit(state({ peakMultiple: 2 }), bad, at(3), FDSA_DEFAULT_EXIT_PLAN)).toEqual({
        action: "hold",
        peakMultiple: 2,
        floorMultiple: 0.5,
      });
    }
  });

  it("leaves dust handling to sellAmount: a sell-all takes everything held", () => {
    const d = decideAdaptiveExit(state({ soldFraction: 0.9995 }), 0.4, at(1), FDSA_DEFAULT_EXIT_PLAN);
    expect(d.action).toBe("sell");
    if (d.action !== "sell") return;
    expect(sellAmount(d, 1_000_000n, 500n)).toBe(500n);
    // A partial that would leave under 0.1% of the original sells the lot.
    const p = decideAdaptiveExit(state({ soldFraction: 0 }), 2, at(2), {
      ...bare,
      partials: [{ atMultiple: 2, sellFraction: 0.9995 }],
    });
    expect(p).toMatchObject({ action: "sell", reason: "partial", all: false });
    if (p.action !== "sell") return;
    expect(sellAmount(p, 1_000_000n, 1_000_000n)).toBe(1_000_000n);
  });
});

describe("FDSA exit plan bounds", () => {
  it("accepts the default plan", () => {
    expect(fdsaExitPlanSchema.safeParse(FDSA_DEFAULT_EXIT_PLAN).success).toBe(true);
  });

  it("refuses a stop looser than -50%, partials over the whole position, and a lock-in at its arm", () => {
    expect(fdsaExitPlanSchema.safeParse({ ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: 0.4 }).success).toBe(
      false,
    );
    expect(
      fdsaExitPlanSchema.safeParse({
        ...FDSA_DEFAULT_EXIT_PLAN,
        partials: [
          { atMultiple: 2, sellFraction: 0.6 },
          { atMultiple: 3, sellFraction: 0.6 },
        ],
      }).success,
    ).toBe(false);
    expect(
      fdsaExitPlanSchema.safeParse({
        ...FDSA_DEFAULT_EXIT_PLAN,
        lockIns: [{ atMultiple: 2, floorMultiple: 2 }],
      }).success,
    ).toBe(false);
  });

  it("clamps a wild proposal into a plan that is safe to run", () => {
    const plan = clampFdsaExitPlan({
      stopMultiple: 0.01,
      lockIns: [{ atMultiple: 3, floorMultiple: 5 }],
      trail: [{ fromMultiple: 2, fraction: 0.99 }],
      partials: [
        { atMultiple: 2, sellFraction: 0.8 },
        { atMultiple: 2, sellFraction: 0.4 },
        { atMultiple: 5, sellFraction: 0.6 },
        { atMultiple: 6, sellFraction: -1 },
      ],
      maxHoldMinutes: 1e9,
      stall: { afterMinutes: 0, belowMultiple: 0 },
    });
    expect(plan).not.toBeNull();
    expect(plan!.stopMultiple).toBe(0.5);
    expect(plan!.lockIns).toEqual([{ atMultiple: 3, floorMultiple: 3 * 0.95 }]);
    expect(plan!.trail).toEqual([{ fromMultiple: 2, fraction: 0.6 }]);
    expect(plan!.partials.map((p) => p.atMultiple)).toEqual([2, 5]);
    expect(plan!.partials.reduce((s, p) => s + p.sellFraction, 0)).toBeLessThanOrEqual(1);
    expect(plan!.maxHoldMinutes).toBe(FDSA_MAX_HOLD_CAP_MINUTES);
    expect(plan!.stall).toEqual({ afterMinutes: 1, belowMultiple: 0.5 });
    expect(fdsaExitPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("caps each list at six steps", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ fromMultiple: 2 + i, fraction: 0.3 }));
    expect(clampFdsaExitPlan({ ...FDSA_DEFAULT_EXIT_PLAN, trail: many })!.trail).toHaveLength(6);
  });

  it("returns null for something that isn't a plan", () => {
    expect(clampFdsaExitPlan(null)).toBeNull();
    expect(clampFdsaExitPlan("sell at 10x")).toBeNull();
    expect(clampFdsaExitPlan({ ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: Number.NaN })).toBeNull();
  });

  it("reads an unreadable stored plan as the hard floor and the default hold, never looser", () => {
    expect(readFdsaExitPlanOrHardFloor({ junk: true })).toEqual({
      stopMultiple: 0.5,
      lockIns: [],
      trail: [],
      partials: [],
      maxHoldMinutes: FDSA_DEFAULT_EXIT_PLAN.maxHoldMinutes,
      stall: null,
    });
  });
});

describe("fdsaFloorMultiple", () => {
  it("ratchets with the peak and never goes down", () => {
    const plan = FDSA_DEFAULT_EXIT_PLAN;
    expect(fdsaFloorMultiple(plan, null, 0.5)).toBe(0.5);
    expect(fdsaFloorMultiple(plan, 1.9, 0.5)).toBe(0.5);
    // 2x: break-even lock-in (1.0) vs the 40% trail (1.2) - the trail wins.
    expect(fdsaFloorMultiple(plan, 2, 0.5)).toBeCloseTo(1.2);
    // 5x: the 4x tier's 30% trail.
    expect(fdsaFloorMultiple(plan, 5, 1.2)).toBeCloseTo(3.5);
    // A lower peak can't pull a stored floor down.
    expect(fdsaFloorMultiple(plan, 2, 3.5)).toBe(3.5);
    expect(fdsaFloorMultiple({ ...plan, stopMultiple: 0.1 }, null, 0)).toBe(0.5);
  });

  it("partial targets are cumulative and capped at the whole position", () => {
    const plan: FdsaExitPlan = {
      ...FDSA_DEFAULT_EXIT_PLAN,
      partials: [
        { atMultiple: 2, sellFraction: 0.25 },
        { atMultiple: 4, sellFraction: 0.25 },
      ],
    };
    expect(fdsaPartialTarget(plan, 1.9)).toBe(0);
    expect(fdsaPartialTarget(plan, 3)).toBe(0.25);
    expect(fdsaPartialTarget(plan, 4)).toBe(0.5);
  });
});

describe("applyFdsaRevision", () => {
  it("holds a revised stop at or above the position's floor", () => {
    const loosen = { ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: 0.5 };
    expect(applyFdsaRevision(loosen, { floorMultiple: 1.8 })!.stopMultiple).toBe(1.8);
    const tighten = { ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: 2.5 };
    expect(applyFdsaRevision(tighten, { floorMultiple: 1.8 })!.stopMultiple).toBe(2.5);
    expect(applyFdsaRevision({ nope: 1 }, { floorMultiple: 1 })).toBeNull();
  });
});

describe("fdsaRevisionDue", () => {
  const opts = { timerMinutes: 10, drawdownPct: 30, minGapSeconds: 120 };
  const base = { openedAt: T0, peakMultiple: 1.1, triggersFired: [] as string[], lastRevisionAt: null };

  it("fires the 2x and 4x crossings once each, the higher one when a jump crosses both", () => {
    expect(fdsaRevisionDue(base, 2.1, at(1), opts)).toEqual({ trigger: "crossed_2x", marks: ["crossed_2x"] });
    expect(fdsaRevisionDue(base, 4.5, at(1), opts)).toEqual({
      trigger: "crossed_4x",
      marks: ["crossed_2x", "crossed_4x"],
    });
    expect(
      fdsaRevisionDue({ ...base, peakMultiple: 2.1, triggersFired: ["crossed_2x"] }, 2.1, at(1), opts),
    ).toBeNull();
  });

  it("rate-limits per position without losing a crossing", () => {
    const recent = { ...base, lastRevisionAt: at(1) };
    expect(fdsaRevisionDue(recent, 2.1, at(2), opts)).toBeNull();
    expect(fdsaRevisionDue(recent, 2.1, at(3), opts)?.trigger).toBe("crossed_2x");
  });

  it("fires a drawdown from the high once per peak, and the timer", () => {
    const high = { ...base, peakMultiple: 3, triggersFired: ["crossed_2x"] };
    const first = fdsaRevisionDue(high, 2, at(4), opts);
    expect(first?.trigger).toBe("drawdown");
    expect(
      fdsaRevisionDue({ ...high, triggersFired: [...high.triggersFired, ...first!.marks] }, 2, at(4), opts),
    ).toBeNull();
    expect(fdsaRevisionDue(base, 1.05, at(10), opts)?.trigger).toBe("timer");
    expect(fdsaRevisionDue({ ...base, lastRevisionAt: at(5) }, 1.05, at(14), opts)).toBeNull();
  });
});

describe("FDSA verdicts", () => {
  it("screens: clamps the score and shortlists at the bar", () => {
    expect(readFdsaScreenAnswer({ score: 0.75, reason: " strong   flow " }, ok, 0.7)).toEqual({
      verdict: { decision: "shortlist", score: 0.75, reason: "strong flow" },
      error: null,
      refused: false,
    });
    expect(readFdsaScreenAnswer({ score: 65, reason: "x" }, ok, 0.7).verdict).toMatchObject({
      decision: "drop",
      score: 0.65,
    });
    expect(readFdsaScreenAnswer({ score: 7, reason: "x" }, ok, 0.7).verdict.score).toBe(0.07);
  });

  it("drops a refused, cut-off, missing or off-schema screen", () => {
    expect(readFdsaScreenAnswer({ score: 1, reason: "x" }, { stopReason: "refusal" }, 0.7)).toMatchObject({
      verdict: { decision: "drop" },
      error: "refused",
      refused: true,
    });
    expect(
      readFdsaScreenAnswer({ score: 1, reason: "x" }, { stopReason: "max_tokens" }, 0.7).verdict.decision,
    ).toBe("drop");
    expect(readFdsaScreenAnswer(null, ok, 0.7).error).toMatch(/no parsable answer/);
    expect(readFdsaScreenAnswer({ score: "high" }, ok, 0.7).error).toMatch(/schema/);
  });

  const trade = {
    decision: "trade",
    probability2x: 0.6,
    probability4x: 0.8,
    conviction: 70,
    exitPlan: { ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: 0.2 },
    reasoning: "Fresh narrative, <b>clean</b> holders.",
    risks: ["dev sold", "", "x".repeat(500)],
  };

  it("decides: clamps the numbers, caps the text and clamps the plan", () => {
    const r = readFdsaDecideAnswer(trade, ok);
    expect(r.error).toBeNull();
    expect(r.verdict).toMatchObject({
      decision: "trade",
      probability2x: 0.6,
      probability4x: 0.6,
      conviction: 0.7,
    });
    expect(r.verdict.exitPlan!.stopMultiple).toBe(0.5);
    expect(r.verdict.reasoning).not.toMatch(/[<>]/);
    expect(r.verdict.risks).toHaveLength(2);
    expect(r.verdict.risks[1]!.length).toBeLessThanOrEqual(143);
  });

  it("stores a trade without a usable plan, a refusal, a cut-off and an invalid answer as a pass", () => {
    expect(readFdsaDecideAnswer({ ...trade, exitPlan: null }, ok)).toMatchObject({
      verdict: { decision: "pass" },
      error: "trade without a usable exit plan",
    });
    expect(readFdsaDecideAnswer(trade, { stopReason: "refusal" })).toMatchObject({
      verdict: { decision: "pass", exitPlan: null },
      refused: true,
    });
    expect(readFdsaDecideAnswer(trade, { stopReason: "max_tokens" }).verdict.decision).toBe("pass");
    expect(readFdsaDecideAnswer({ ...trade, decision: "buy" }, ok)).toMatchObject({
      verdict: { decision: "pass" },
    });
    expect(readFdsaDecideAnswer(undefined, { stopReason: null }).error).toMatch(/no parsable answer/);
  });

  it("a pass keeps no plan", () => {
    expect(readFdsaDecideAnswer({ ...trade, decision: "pass" }, ok).verdict.exitPlan).toBeNull();
  });

  it("holds a trade under the bar as a pass that names the bar, and takes one at it", () => {
    const under = readFdsaDecideAnswer({ ...trade, probability2x: 0.35 }, ok, 0.5);
    expect(under.error).toBeNull();
    expect(under.verdict).toMatchObject({
      decision: "pass",
      probability2x: 0.35,
      exitPlan: null,
      risks: [fdsaTradeBarRisk(0.5), "dev sold", expect.any(String)],
    });
    expect(fdsaTradeBarRisk(0.5)).toBe("2x odds under the desk's 50% bar");
    expect(readFdsaDecideAnswer({ ...trade, probability2x: 0.5 }, ok, 0.5).verdict.decision).toBe("trade");
    // A percent answer is read as one before the bar (35 is 35%).
    expect(readFdsaDecideAnswer({ ...trade, probability2x: 35 }, ok, 0.5).verdict.decision).toBe("pass");
    // No bar: the model's word stands, as before.
    expect(readFdsaDecideAnswer({ ...trade, probability2x: 0.1 }, ok).verdict.decision).toBe("trade");
    expect(DEFAULT_FDSA_TRADE_MIN_P2X).toBe(0.5);
  });

  it("ranked: trades on the odds against the line whatever the answer says, under a safe plan", () => {
    const at = readFdsaDecideAnswer(
      { ...trade, decision: "pass", probability2x: 0.2, exitPlan: null },
      ok,
      0.2,
      {
        ranked: true,
      },
    );
    expect(at.error).toBeNull();
    expect(at.verdict.decision).toBe("trade");
    expect(at.verdict.exitPlan).toEqual(clampFdsaExitPlan(FDSA_DEFAULT_EXIT_PLAN));
    // The model's own plan when it is usable.
    const own = readFdsaDecideAnswer({ ...trade, decision: "pass", probability2x: 0.3 }, ok, 0.2, {
      ranked: true,
    });
    expect(own.verdict.exitPlan).toEqual(clampFdsaExitPlan(trade.exitPlan));
    const under = readFdsaDecideAnswer({ ...trade, probability2x: 0.15 }, ok, 0.2, { ranked: true });
    expect(under.verdict).toMatchObject({ decision: "pass", exitPlan: null });
    expect(under.verdict.risks[0]).toBe(fdsaTradeBarRisk(0.2));
    // An unusable answer is still never a trade.
    expect(readFdsaDecideAnswer(trade, { stopReason: "refusal" }, 0, { ranked: true }).verdict.decision).toBe(
      "pass",
    );
  });

  it("names one prompt version per stage", () => {
    expect(Object.keys(FDSA_PROMPT_VERSIONS).sort()).toEqual(["decide", "revise", "screen"]);
    expect(new Set(Object.values(FDSA_PROMPT_VERSIONS)).size).toBe(3);
    expect(FDSA_PROMPT_VERSION).toBe(FDSA_PROMPT_VERSIONS.decide);
  });

  it("revises only with a usable plan; anything else keeps the running one", () => {
    const plan = { ...FDSA_DEFAULT_EXIT_PLAN, stopMultiple: 1.5 };
    expect(
      readFdsaReviseAnswer({ action: "revise", exitPlan: plan, reason: "ran to 3x" }, ok).verdict,
    ).toMatchObject({
      action: "revise",
      proposed: plan,
    });
    expect(readFdsaReviseAnswer({ action: "revise", exitPlan: null, reason: "r" }, ok)).toMatchObject({
      verdict: { action: "keep" },
      error: "revision without a usable exit plan",
    });
    expect(
      readFdsaReviseAnswer({ action: "revise", exitPlan: plan, reason: "r" }, { stopReason: "refusal" })
        .verdict.action,
    ).toBe("keep");
    expect(readFdsaReviseAnswer({ action: "keep", exitPlan: null, reason: "fine" }, ok)).toMatchObject({
      verdict: { action: "keep", reason: "fine" },
      error: null,
    });
  });

  it("one screen and one decide per token; revisions repeat", () => {
    expect(fdsaReviewDedupeKey("tok", "screen")).toBe("tok:screen");
    expect(fdsaReviewDedupeKey("tok", "decide")).toBe("tok:decide");
    expect(fdsaReviewDedupeKey("tok", "revise")).toBeNull();
  });
});

describe("FDSA desk", () => {
  it("is Paper only: Live is named but never readable", () => {
    expect(FDSA_AVAILABLE_MODES).toEqual(["paper"]);
    expect(readFdsaMode("paper")).toBe("paper");
    expect(readFdsaMode("live")).toBe("paper");
    expect(readFdsaMode(undefined)).toBe("paper");
  });

  it("defaults to 0.5 SOL a trade, 6 open, 100 SOL a day on a 10 SOL bankroll, with the bot's guards", () => {
    expect(DEFAULT_FDSA_BANKROLL_SOL).toBe(10);
    expect(DEFAULT_FDSA_DESK_CONFIG).toMatchObject({
      buySol: 0.5,
      maxOpenPositions: 6,
      maxDailySpendSol: 100,
    });
    // Not the bot's one-buy-a-day 0.5 SOL.
    expect(DEFAULT_TRADING_BOT_CONFIG.maxDailySpendSol).toBe(0.5);
    for (const k of [
      "reserveSol",
      "slippageBps",
      "exitSlippageBps",
      "jitoTipSol",
      "dailyLossLimitSol",
      "maxSignalAgeSeconds",
    ] as const) {
      expect(DEFAULT_FDSA_DESK_CONFIG[k]).toBe(DEFAULT_TRADING_BOT_CONFIG[k]);
    }
    expect(DEFAULT_FDSA_DESK_CONFIG.fillPenaltyBps).toBe(DEFAULT_PAPER_CONFIG.fillPenaltyBps);
    expect("sources" in DEFAULT_FDSA_DESK_CONFIG).toBe(false);
    expect("exitPlan" in DEFAULT_FDSA_DESK_CONFIG).toBe(false);
  });

  it("reads a broken config as the defaults", () => {
    expect(readFdsaDeskConfig({ buySol: -1 })).toEqual(DEFAULT_FDSA_DESK_CONFIG);
    expect(readFdsaDeskConfig({ buySol: 0.25 }).buySol).toBe(0.25);
  });
});

describe("FDSA budget", () => {
  const env = loadEnv({ DATABASE_URL: "postgresql://x/y" });
  const row = (source: string, costUsd: number, refused = 0) => ({
    source,
    costUsd,
    calls: 1,
    refused,
    capUsd: 20,
    updatedAt: T0,
  });

  it("is off by default, on its own $20 cap with a quarter kept for exits", () => {
    expect(env.FDSA_ENABLED).toBe(false);
    expect(env.FDSA_DAILY_BUDGET_USD).toBe(20);
    expect(env.FDSA_EXIT_RESERVE_PCT).toBe(25);
    expect(fdsaSpendLimitUsd(env, "fdsa-screen")).toBe(15);
    expect(fdsaSpendLimitUsd(env, "fdsa-decide")).toBe(15);
    expect(fdsaSpendLimitUsd(env, "fdsa-exit")).toBe(20);
  });

  it("keeps the reviewer's and FDSA's spend on separate ledgers", () => {
    for (const s of ["fdsa-screen", "fdsa-decide", "fdsa-exit"]) expect(aiSpendLedger(s)).toBe("fdsa");
    for (const s of ["review", "review-spare", "text", "playbook", "replay"])
      expect(aiSpendLedger(s)).toBe("reviewer");
  });

  it("stops reviews at the cap less the exit reserve, and exits only at the whole cap", () => {
    expect(summarizeFdsaBudget(env, "d", [row("fdsa-decide", 10)], T0)).toMatchObject({
      reviewsStopped: false,
      exitsStopped: false,
      remainingUsd: 10,
    });
    expect(summarizeFdsaBudget(env, "d", [row("fdsa-decide", 15)], T0)).toMatchObject({
      reviewsStopped: true,
      exitsStopped: false,
    });
    expect(summarizeFdsaBudget(env, "d", [row("fdsa-decide", 15), row("fdsa-exit", 5)], T0)).toMatchObject({
      reviewsStopped: true,
      exitsStopped: true,
      remainingUsd: 0,
    });
    expect(summarizeFdsaBudget(env, "d", [row("fdsa-screen", 1, 1)], T0).reviewsStopped).toBe(true);
  });
});

describe.skipIf(!dbAvailable)("FDSA spend ledger", () => {
  // A day no other test writes, cleared after.
  const when = new Date("2099-03-04T12:00:00Z");
  const day = "2099-03-04";
  const env = loadEnv({ DATABASE_URL: "postgresql://x/y" });
  afterAll(async () => {
    if (dbAvailable) await prisma.aiSpend.deleteMany({ where: { day } });
  });

  it("FDSA spend never counts against the reviewer's cap, nor the reviewer's against FDSA's", async () => {
    await addAiSpend(day, "review", { costUsd: 4, calls: 1 }, 15);
    await addAiSpend(day, "fdsa-decide", { costUsd: 9, calls: 1 }, 20);
    await addAiSpend(day, "fdsa-exit", { costUsd: 1, calls: 1 }, 20);

    expect(await aiSpentUsd(day)).toBeCloseTo(4);
    expect(await aiSpentUsd(day, "reviewer")).toBeCloseTo(4);
    expect(await aiSpentUsd(day, "fdsa")).toBeCloseTo(10);
    expect(await fdsaSourceSpentUsd(day, "fdsa-exit")).toBeCloseTo(1);

    const reviewer = await readAiBudget(env, when);
    expect(reviewer.spentUsd).toBeCloseTo(4);
    expect(reviewer.bySource.map((r) => r.source)).toEqual(["review"]);
    const fdsa = await readFdsaBudget(env, when);
    expect(fdsa).toMatchObject({ capUsd: 20, spentUsd: 10, remainingUsd: 10, reviewsStopped: false });
    expect(fdsa.bySource.map((r) => r.source)).toEqual(["fdsa-decide", "fdsa-exit"]);

    const rows = await prisma.aiSpend.findMany({ where: { day }, orderBy: { source: "asc" } });
    expect(rows.map((r) => [r.source, r.ledger])).toEqual([
      ["fdsa-decide", "fdsa"],
      ["fdsa-exit", "fdsa"],
      ["review", "reviewer"],
    ]);
  });
});

describe.skipIf(!dbAvailable)("FDSA schema", () => {
  const mint = "FdsaSchemaTestMint1111111111111111111111111";
  afterAll(async () => {
    if (dbAvailable) await prisma.fdsaPosition.deleteMany({ where: { mint } });
  });

  it("holds the desk to one row in Paper mode, and one entry per mint", async () => {
    const desk = await prisma.fdsaDesk.upsert({
      where: { id: "fdsa" },
      create: {
        id: "fdsa",
        config: {},
        bankrollLamports: 20n * 1_000_000_000n,
        cashLamports: 20n * 1_000_000_000n,
      },
      update: {},
    });
    expect(desk.mode).toBe("paper");
    // A new desk starts stopped. Read from the column default: the paper desk's suite shares this
    // one row and may be running it while this suite runs.
    const [col] = await prisma.$queryRaw<{ d: string | null }[]>`
      SELECT column_default AS d FROM information_schema.columns
      WHERE table_name = 'FdsaDesk' AND column_name = 'running'`;
    expect(col?.d).toBe("false");
    await expect(prisma.fdsaDesk.update({ where: { id: "fdsa" }, data: { mode: "live" } })).rejects.toThrow();
    await expect(
      prisma.fdsaDesk.create({ data: { id: "second", config: {}, bankrollLamports: 1n, cashLamports: 1n } }),
    ).rejects.toThrow();

    const position = {
      deskId: "fdsa",
      mint,
      signalAt: T0,
      openedAt: T0,
      // Closed, so the paper desk's suite (paperDesk.test.ts), which shares the one desk, never
      // walks it as an open position.
      status: "closed",
      swapInLamports: 500_000_000n,
      tokensBought: "1000",
      tokensHeld: "1000",
      decimals: 6,
      exitPlan: FDSA_DEFAULT_EXIT_PLAN,
      floorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
    };
    const first = await prisma.fdsaPosition.create({ data: position });
    expect(first).toMatchObject({ sourceKind: "fdsa", mode: "paper", planVersion: 1, soldFraction: 0 });
    await expect(prisma.fdsaPosition.create({ data: position })).rejects.toThrow();
    await expect(
      prisma.fdsaPosition.update({ where: { id: first.id }, data: { mode: "live" } }),
    ).rejects.toThrow();
  });
});

/**
 * Paper only (decision 6): no FDSA module may reach a key or build, sign or send a transaction.
 * Checks every FDSA source file in the repo - this directory, and the worker's and API's FDSA
 * files as later threads add them - for an import of the modules that do, or of anything they
 * export through the package root.
 */
describe("FDSA cannot sign", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, "../../../..");
  const tradingDir = join(here, "../trading");
  const BANNED_MODULES = [
    "keyVault",
    "transaction",
    "wallets",
    "serverWallet",
    "sender",
    "txGuard",
    "pumpSwap",
  ];
  const bannedNames = new Set<string>();
  for (const m of BANNED_MODULES) {
    const src = readFileSync(join(tradingDir, `${m}.ts`), "utf8");
    for (const match of src.matchAll(
      /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g,
    )) {
      bannedNames.add(match[1]!);
    }
  }

  function filesUnder(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries.flatMap((e) => {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) return filesUnder(p);
      return /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [p] : [];
    });
  }
  const fdsaFiles = [
    ...filesUnder(here),
    ...filesUnder(join(repo, "apps/worker/src/fdsa")),
    ...filesUnder(join(repo, "apps/api/src/fdsa")),
    ...filesUnder(join(repo, "apps/api/src/routes")).filter((f) => /fdsa/i.test(f)),
    ...filesUnder(join(repo, "apps/worker/src/jobs")).filter((f) => /fdsa/i.test(f)),
  ];

  it("finds the FDSA sources and the names to ban", () => {
    expect(fdsaFiles.length).toBeGreaterThanOrEqual(4);
    expect(bannedNames.has("withWalletKey")).toBe(true);
  });

  it("no FDSA file imports the key provider or the transaction builder", () => {
    const offences: string[] = [];
    for (const file of fdsaFiles) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
        const [, names, spec] = m;
        const base = spec!
          .split("/")
          .at(-1)!
          .replace(/\.(js|ts)$/, "");
        if (spec!.startsWith(".") && BANNED_MODULES.includes(base))
          offences.push(`${relative(repo, file)}: ${spec}`);
        if (spec === "@trenchscanner/core" || spec!.startsWith(".")) {
          for (const n of names!.replace(/[{}]/g, " ").split(/[\s,]+/)) {
            const name = n.replace(/^type\s+/, "");
            if (bannedNames.has(name)) offences.push(`${relative(repo, file)}: ${name}`);
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
