import { describe, expect, it } from "vitest";
import {
  FDSA_LAB_FRICTIONS,
  LADDER_AS_FDSA_PLAN,
  labPlanGrid,
  labPointsFromPath,
  replayExitPlan,
  runExitLab,
  summarizeLab,
  type LabFrictions,
  type LabPoint,
  type LabTrade,
} from "./exitLab.js";
import {
  FDSA_DEFAULT_EXIT_PLAN,
  FDSA_HARD_FLOOR_MULTIPLE,
  fdsaExitPlanSchema,
  type FdsaExitPlan,
} from "./exitPlan.js";

/** No frictions: entry at the alert, a tick a second, fills at the tick. */
const CLEAN: LabFrictions = { entryDelaySec: 0, tickSec: 1, sellDelaySec: 0, fillPenaltyPct: 0 };

const trade = (points: LabPoint[], extra: Partial<LabTrade> = {}): LabTrade => ({
  id: "a",
  mint: "M",
  alertAt: new Date("2026-11-01T00:00:00Z"),
  points,
  ...extra,
});

/** A path through the given multiples, one per `step` seconds. */
const path = (rels: number[], step = 1): LabPoint[] => rels.map((rel, i) => ({ sec: i * step, rel }));

const HOLD_ONLY: FdsaExitPlan = {
  stopMultiple: FDSA_HARD_FLOOR_MULTIPLE,
  lockIns: [],
  trail: [],
  partials: [],
  maxHoldMinutes: 180,
  stall: null,
};

describe("replayExitPlan", () => {
  it("stops out at the -50% floor and fills at the price it crashed to", () => {
    const r = replayExitPlan(trade(path([1, 1.2, 0.8, 0.4, 0.3])), HOLD_ONLY, CLEAN)!;
    expect(r.reason).toBe("stop_loss");
    // Decided at the 0.4 tick, filled there: a gap through the stop fills under it, as live.
    expect(r.returnPct).toBeCloseTo(-60);
    expect(r.pathPeak).toBeCloseTo(1.2);
  });

  it("marks a position still open at the path's end at the last price", () => {
    const r = replayExitPlan(trade(path([1, 1.5, 1.4])), HOLD_ONLY, CLEAN)!;
    expect(r.reason).toBe("path_end");
    expect(r.returnPct).toBeCloseTo(40);
  });

  it("sells partials at their level and trails the rest", () => {
    const plan: FdsaExitPlan = {
      ...HOLD_ONLY,
      trail: [{ fromMultiple: 2, fraction: 0.25 }],
      partials: [{ atMultiple: 2, sellFraction: 0.5 }],
    };
    const r = replayExitPlan(trade(path([1, 2, 3, 2.2, 2])), plan, CLEAN)!;
    // Half at 2x, the rest when 2.2 falls under 3 x 0.75 = 2.25.
    expect(r.reason).toBe("floor");
    expect(r.returnPct).toBeCloseTo((0.5 * 2 + 0.5 * 2.2 - 1) * 100);
  });

  it("only sees the price on its ticks, so a spike between ticks is missed and a crash fills late", () => {
    const pts = path([1, 1, 2.5, 1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1]);
    const plan: FdsaExitPlan = { ...HOLD_ONLY, partials: [{ atMultiple: 2, sellFraction: 1 }] };
    expect(replayExitPlan(trade(pts), plan, CLEAN)!.reason).toBe("partial");
    const slow = replayExitPlan(trade(pts), plan, { ...CLEAN, tickSec: 5 })!;
    expect(slow.reason).toBe("path_end");
  });

  it("enters after the delay and pays the fill penalty both ways", () => {
    const fr: LabFrictions = { entryDelaySec: 2, tickSec: 1, sellDelaySec: 0, fillPenaltyPct: 1 };
    const r = replayExitPlan(trade(path([1, 1, 2, 2, 2])), HOLD_ONLY, fr)!;
    expect(r.reason).toBe("path_end");
    expect(r.returnPct).toBeCloseTo(((2 * 0.99) / (2 * 1.01) - 1) * 100);
  });

  it("skips a path that starts after the alert or ends before the entry fills", () => {
    expect(
      replayExitPlan(
        trade([
          { sec: 5, rel: 1 },
          { sec: 9, rel: 2 },
        ]),
        HOLD_ONLY,
        CLEAN,
      ),
    ).toBeNull();
    expect(replayExitPlan(trade(path([1, 1.1])), HOLD_ONLY, FDSA_LAB_FRICTIONS)).toBeNull();
  });

  it("closes on the stall rule when the move doesn't come", () => {
    const plan: FdsaExitPlan = { ...HOLD_ONLY, stall: { afterMinutes: 1, belowMultiple: 1.1 } };
    const r = replayExitPlan(trade(path(Array.from({ length: 200 }, () => 1.02))), plan, CLEAN)!;
    expect(r.reason).toBe("stall");
    expect(r.holdSec).toBe(60);
  });
});

describe("labPointsFromPath", () => {
  const start = new Date("2026-11-01T00:00:00Z");
  it("cuts a recorded path at the alert second, relative to its price", () => {
    const rows = [
      { sec: 0, price: 1 },
      { sec: 10, price: 2 },
      { sec: 30, price: 4 },
    ];
    const pts = labPointsFromPath(rows, start, new Date(start.getTime() + 15_000))!;
    expect(pts).toEqual([
      { sec: 0, rel: 1 },
      { sec: 15, rel: 2 },
    ]);
  });
  it("is null when the path doesn't cover the alert", () => {
    const rows = [
      { sec: 5, price: 1 },
      { sec: 10, price: 2 },
    ];
    expect(labPointsFromPath(rows, start, start)).toBeNull();
    expect(labPointsFromPath(rows, start, new Date(start.getTime() + 20_000))).toBeNull();
  });
});

describe("labPlanGrid", () => {
  it("is all valid plans", () => {
    const grid = labPlanGrid();
    expect(grid.length).toBe(648);
    for (const p of grid) expect(fdsaExitPlanSchema.safeParse(p).success).toBe(true);
    expect(fdsaExitPlanSchema.safeParse(LADDER_AS_FDSA_PLAN).success).toBe(true);
  });
});

describe("runExitLab", () => {
  it("picks the plan on the earlier trades and grades it on the later ones", async () => {
    // Coins that pop to 1.5x then die: a plan that banks 1.5x beats one that waits for 2x.
    const popAndDie = path([1, 1.2, 1.5, 1.5, 1.2, 0.9, 0.6, 0.4, 0.3, 0.3], 10);
    const trades = Array.from({ length: 30 }, (_, i) =>
      trade(popAndDie, {
        id: `t${i}`,
        alertAt: new Date(Date.UTC(2026, 10, 1, i)),
        shortlisted: i % 2 === 0,
        claudePlan: i === 29 ? FDSA_DEFAULT_EXIT_PLAN : null,
      }),
    );
    const grid = [
      HOLD_ONLY,
      {
        ...HOLD_ONLY,
        lockIns: [{ atMultiple: 1.3, floorMultiple: 1.0 }],
        partials: [{ atMultiple: 1.5, sellFraction: 0.5 }],
      },
    ];
    const report = await runExitLab(trades, { frictions: CLEAN, grid });
    expect(report.trades).toEqual({ train: 20, test: 10, shortlisted: 15 });
    expect(report.tuned!.plan).toEqual(grid[1]);
    expect(report.tuned!.test.meanReturnPct!).toBeGreaterThan(report.baselines[0]!.test.meanReturnPct!);
    expect(report.testFrom).toBe(new Date(Date.UTC(2026, 10, 1, 20)).toISOString());
    expect(report.claudePlans!.trades).toBe(1);
    expect(report.shortlisted.map((s) => s.name)).toEqual(["tuned", "fdsa-default", "ladder"]);
  });
});

describe("summarizeLab", () => {
  it("is null-safe on nothing", () => {
    expect(summarizeLab([]).meanReturnPct).toBeNull();
  });
  it("splits doubled and not, and measures capture of the peak", () => {
    const s = summarizeLab([
      { returnPct: 50, reason: "floor", holdSec: 60, pathPeak: 3 },
      { returnPct: -50, reason: "stop_loss", holdSec: 30, pathPeak: 1.1 },
    ]);
    expect(s.doubledMeanPct).toBe(50);
    expect(s.notDoubledMeanPct).toBe(-50);
    expect(s.captureOfPeak).toBe(0.25);
    expect(s.stopLossMeanPct).toBe(-50);
    expect(s.byReason).toEqual({ floor: 1, stop_loss: 1 });
  });
});
