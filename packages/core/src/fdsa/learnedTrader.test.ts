import { describe, expect, it } from "vitest";
import { FDSA_LAB_FRICTIONS, replayExitPlan, runExitLab, type LabPoint, type LabTrade } from "./exitLab.js";
import { FDSA_DEFAULT_EXIT_PLAN } from "./exitPlan.js";
import {
  learnedTraderFeatures,
  replayLearned,
  scoreLearnedTrader,
  traceTrades,
  trainLearnedTrader,
} from "./learnedTrader.js";

const FR = FDSA_LAB_FRICTIONS;

/**
 * Two kinds of coin that look alike for the first minute (a climb to 1.15x): a fader, whose buyers
 * turn to sellers and which bleeds to 0.82x, and a runner, still bought, which goes to 3x. The
 * tape's net SOL tells them apart from the top on; the price alone takes a while to.
 */
function coin(i: number, runner: boolean): LabTrade {
  const points: LabPoint[] = [];
  for (let sec = 0; sec <= 900; sec += 2) {
    let rel: number;
    if (sec <= 60) rel = 1 + (0.15 * sec) / 60;
    else if (runner) rel = Math.min(3, 1.15 + ((sec - 60) / 600) * 1.85);
    else rel = Math.max(0.82, 1.15 - ((sec - 60) / 240) * 0.33);
    // A little noise so the paths aren't identical; deterministic per coin.
    rel *= 1 + 0.01 * Math.sin(sec * 0.7 + i);
    const netSol = sec <= 60 ? 0.5 : runner ? 0.4 : -0.6;
    points.push({ sec, rel, netSol, changes: 3 });
  }
  return { id: `c${i}`, mint: `M${i}`, alertAt: new Date(Date.UTC(2026, 10, 1, 0, i)), points };
}

const coins = Array.from({ length: 120 }, (_, i) => coin(i, i % 3 === 0));

describe("learned trader", () => {
  it("reads only the tape up to the tick", () => {
    const t = coin(1, false);
    const tick = {
      sec: 100,
      heldSec: 84,
      multiple: 1,
      peakMultiple: 1.1,
      floorMultiple: 0.8,
      soldFraction: 0,
      entryRel: 1,
      exitValue: 1,
    };
    const f = learnedTraderFeatures(t, tick);
    const cut = { ...t, points: t.points.filter((p) => p.sec <= 100) };
    expect(learnedTraderFeatures(cut, tick)).toEqual(f);
    expect(f.netSol30).toBeLessThan(0);
  });

  it("sells everything on the hook's word, only on ticks the plan holds", () => {
    const r = replayExitPlan(coin(2, true), FDSA_DEFAULT_EXIT_PLAN, FR, (tick) => tick.heldSec >= 40)!;
    expect(r.reason).toBe("learned");
    expect(r.holdSec).toBe(40 + FR.sellDelaySec);
  });

  it("traces the plan alone exactly", () => {
    const [traced] = traceTrades([coin(3, false)], FDSA_DEFAULT_EXIT_PLAN, FR);
    expect(traced!.plan).toEqual(replayExitPlan(coin(3, false), FDSA_DEFAULT_EXIT_PLAN, FR));
    expect(traced!.ticks.length).toBeGreaterThan(5);
  });

  it("learns to cut faders early, and its fast scoring matches a full replay", async () => {
    const train = coins.slice(0, 80);
    const test = coins.slice(80);
    const trader = (await trainLearnedTrader(train, FDSA_DEFAULT_EXIT_PLAN, FR))!;
    expect(trader).not.toBeNull();
    expect(Number.isFinite(trader.cut)).toBe(true);
    const fast = scoreLearnedTrader(trader, test, FR);
    const full = test.map((t) => replayLearned(trader, t, FR)!);
    for (let i = 0; i < full.length; i++) {
      expect(fast[i]!.returnPct).toBeCloseTo(full[i]!.returnPct, 9);
      expect(fast[i]!.reason).toBe(full[i]!.reason);
      expect(fast[i]!.holdSec).toBe(full[i]!.holdSec);
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const plan = test.map((t) => replayExitPlan(t, FDSA_DEFAULT_EXIT_PLAN, FR)!.returnPct);
    expect(mean(fast.map((r) => r.returnPct))).toBeGreaterThan(mean(plan));
  });

  it("is in the lab's report, graded on the later coins", async () => {
    const report = await runExitLab(coins, { grid: [FDSA_DEFAULT_EXIT_PLAN] });
    expect(report.learned).not.toBeNull();
    expect(report.learned!.test.trades).toBe(40);
    expect(report.learned!.test.meanReturnPct!).toBeGreaterThan(report.tuned!.test.meanReturnPct!);
    const off = await runExitLab(coins, { grid: [FDSA_DEFAULT_EXIT_PLAN], learned: false });
    expect(off.learned).toBeNull();
  });

  it("does nothing with too little to learn from", async () => {
    expect(await trainLearnedTrader(coins.slice(0, 3), FDSA_DEFAULT_EXIT_PLAN, FR)).toBeNull();
  });
});
