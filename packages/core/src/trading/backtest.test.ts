import { describe, expect, it } from "vitest";
import { backtestHit2x, summarizeBacktest, type BacktestCall } from "./backtest.js";

const call = (over: Partial<BacktestCall>): BacktestCall => ({
  model: "rules",
  modelName: "Rules",
  tier: null,
  hit2x: false,
  simReturnPct: -20,
  aiDecision: null,
  ...over,
});

describe("trading backtest", () => {
  it("splits each model's graded calls by tier and AI verdict", () => {
    const rows = summarizeBacktest([
      call({ hit2x: true, simReturnPct: 80, tier: "high", aiDecision: "buy" }),
      call({ hit2x: true, simReturnPct: 60, aiDecision: "buy" }),
      call({ hit2x: false, simReturnPct: -30, tier: "high", aiDecision: "no_buy" }),
      call({ hit2x: false, simReturnPct: -30 }),
      call({ hit2x: null, simReturnPct: null }),
      call({ model: "forest", modelName: "Forest", hit2x: true, simReturnPct: 50 }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["rules", "forest"]);
    const rules = rows[0]!;
    expect(rules.all).toEqual({ calls: 4, wins: 2, hitRate: 0.5, avgReturnPct: 20 });
    expect(rules.high).toMatchObject({ calls: 2, wins: 1, hitRate: 0.5 });
    expect(rules.aiBuy).toEqual({ calls: 2, wins: 2, hitRate: 1, avgReturnPct: 70 });
    expect(rules.highAiBuy).toMatchObject({ calls: 1, wins: 1 });
    expect(rows[1]!.highAiBuy).toEqual({ calls: 0, wins: 0, hitRate: null, avgReturnPct: null });
  });

  it("counts a stopped-out 2x as a loss", () => {
    expect(backtestHit2x(true, true)).toBe(false);
    expect(backtestHit2x(true, false)).toBe(true);
    expect(backtestHit2x(true, null)).toBe(true);
    expect(backtestHit2x(false, null)).toBe(false);
    expect(backtestHit2x(null, null)).toBeNull();
  });
});
