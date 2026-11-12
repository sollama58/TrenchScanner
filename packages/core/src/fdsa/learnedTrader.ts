import {
  scoreBoosted,
  trainBoostedCurator,
  type BoostedCuratorParams,
  type BoostingRow,
} from "../curation/boosting.js";
import {
  replayExitPlan,
  summarizeLab,
  type LabFrictions,
  type LabPoint,
  type LabResult,
  type LabSummary,
  type LabTick,
  type LabTrade,
} from "./exitLab.js";
import type { FdsaExitPlan } from "./exitPlan.js";

/**
 * The learned trader, phase 2 of the trader models (owner decisions 2026-11-07 "Lab, tuned rule,
 * then learned" and 2026-11-12 "Tuned plan as floor, then phase 2"): a model that watches an open
 * position tick by tick and decides when to sell everything, trained on the same recorded price
 * paths the exit lab replays.
 *
 * It runs on top of a rule plan (the lab's tuned plan), never instead of it: on every tick the
 * plan's own stop, trail, partials and stall decide first, exactly as on the desk, and the model
 * is asked only when the plan holds. So it can only sell earlier than the plan, and the plan's
 * floor still protects every position it holds.
 *
 * What it learns. Because it only ever sells everything, a position is in the plan's own state
 * until the model's first sale, so one replay of the plan alone gives, for every tick it held:
 * what selling everything right then would have returned, and what holding on under the plan did
 * return. The label is whether selling then beat holding. The model (the curator's gradient-boosted
 * trees, logistic) reads only what the desk could see at that tick: the position (multiple, peak,
 * floor, time held) and the last two minutes of the coin's tape (returns, range, trade count, net
 * SOL in). Its cut, the odds at which it sells, is picked on the training coins, with "never" among
 * the choices, so on the coins it trained on it can't do worse than the plan it rides on.
 *
 * Shadow only: the lab reports it beside the plans on the later coins it never saw. Nothing here
 * changes what the desk runs.
 */

export const LEARNED_TRADER_FEATURES = [
  "multiple",
  "peak",
  "fromPeak",
  "overFloor",
  "heldSec",
  "soldFraction",
  "ret10",
  "ret30",
  "ret60",
  "ret120",
  "high60",
  "low60",
  "changes30",
  "changes120",
  "netSol30",
  "netSol120",
] as const;

/** The odds cuts tried. */
const CUTS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
/** A cut must beat the plan alone on the training coins by this many points of mean return. */
const MIN_GAIN_PCT = 0.25;

/** Index of the last point at or before `sec` (-1 if none). */
function indexAt(points: readonly LabPoint[], sec: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.sec <= sec) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The model's inputs at a tick: the position and the tape up to that second, nothing later. */
export function learnedTraderFeatures(trade: LabTrade, tick: LabTick): Record<string, number | null> {
  const pts = trade.points;
  const i = indexAt(pts, tick.sec);
  const now = i >= 0 ? pts[i]!.rel : null;
  const relAt = (sec: number) => {
    const j = indexAt(pts, sec);
    return j >= 0 ? pts[j]!.rel : null;
  };
  const ret = (back: number) => {
    const then = relAt(tick.sec - back);
    return now !== null && then !== null && then > 0 ? now / then - 1 : null;
  };
  let high = now ?? 0;
  let low = now ?? Infinity;
  let changes30 = 0;
  let changes120 = 0;
  let netSol30: number | null = null;
  let netSol120: number | null = null;
  for (let j = i; j >= 0 && pts[j]!.sec > tick.sec - 120; j--) {
    const p = pts[j]!;
    const in30 = p.sec > tick.sec - 30;
    const n = p.changes ?? 1;
    changes120 += n;
    if (in30) changes30 += n;
    if (p.netSol !== undefined) {
      netSol120 = (netSol120 ?? 0) + p.netSol;
      if (in30) netSol30 = (netSol30 ?? 0) + p.netSol;
    }
    if (p.sec > tick.sec - 60) {
      high = Math.max(high, p.rel);
      low = Math.min(low, p.rel);
    }
  }
  return {
    multiple: tick.multiple,
    peak: tick.peakMultiple,
    fromPeak: tick.peakMultiple > 0 ? tick.multiple / tick.peakMultiple : null,
    overFloor: tick.floorMultiple > 0 ? tick.multiple / tick.floorMultiple : null,
    heldSec: tick.heldSec,
    soldFraction: tick.soldFraction,
    ret10: ret(10),
    ret30: ret(30),
    ret60: ret(60),
    ret120: ret(120),
    high60: now && now > 0 ? high / now : null,
    low60: now && now > 0 && Number.isFinite(low) ? low / now : null,
    changes30,
    changes120,
    netSol30,
    netSol120,
  };
}

/** One tick the plan held: its inputs and what selling everything there would have returned. */
export interface TracedTick {
  features: Record<string, number | null>;
  /** Return, percent, had everything been sold on this tick, and the hold that sale would end. */
  exitPct: number;
  holdSec: number;
}

/** A trade under the plan alone: every tick it held, and how the plan itself ended. */
export interface TracedTrade {
  trade: LabTrade;
  ticks: TracedTick[];
  plan: LabResult;
}

/** Replays `plan` alone on each trade, keeping every tick it held. Untradeable paths drop out. */
export function traceTrades(
  trades: readonly LabTrade[],
  plan: FdsaExitPlan,
  fr: LabFrictions,
): TracedTrade[] {
  const out: TracedTrade[] = [];
  for (const trade of trades) {
    const ticks: TracedTick[] = [];
    const last = trade.points.at(-1)?.sec ?? 0;
    const result = replayExitPlan(trade, plan, fr, (tick) => {
      ticks.push({
        features: learnedTraderFeatures(trade, tick),
        exitPct: (tick.exitValue - 1) * 100,
        holdSec: Math.min(tick.sec + fr.sellDelaySec, last) - fr.entryDelaySec,
      });
      return false;
    });
    if (result) out.push({ trade, ticks, plan: result });
  }
  return out;
}

/**
 * The trader's result on a traced trade at a cut: the first tick whose odds reach it sells
 * everything there; with none, the plan's own result. Exact, not an estimate: up to that tick the
 * position is in the plan's state (see the header), and replayLearned checks it against a replay.
 */
function resultAtCut(t: TracedTrade, odds: readonly number[], cut: number): LabResult {
  for (let k = 0; k < t.ticks.length; k++) {
    if (odds[k]! >= cut) {
      const k0 = t.ticks[k]!;
      return { ...t.plan, returnPct: k0.exitPct, holdSec: k0.holdSec, reason: "learned" };
    }
  }
  return t.plan;
}

const meanReturn = (rs: readonly LabResult[]) =>
  rs.length ? rs.reduce((s, r) => s + r.returnPct, 0) / rs.length : -Infinity;

export type LearnedTraderModel = Omit<BoostedCuratorParams, "threshold">;

export interface LearnedTrader {
  model: LearnedTraderModel;
  /** The odds at or over which it sells everything; Infinity = never (the plan alone was best). */
  cut: number;
  /** The plan it rides on. */
  plan: FdsaExitPlan;
  rows: number;
  /** Share of training ticks where selling then beat holding on. */
  sellShare: number;
  train: LabSummary;
}

/** Picks every traced trade's per-tick odds under `model`. */
function oddsOf(model: LearnedTraderModel, traced: readonly TracedTrade[]): number[][] {
  return traced.map((t) => t.ticks.map((k) => scoreBoosted(model, k.features)));
}

/** Trains the trader on `trades` over `plan`; null when there are too few ticks to learn from. */
export async function trainLearnedTrader(
  trades: readonly LabTrade[],
  plan: FdsaExitPlan,
  fr: LabFrictions,
  opts: { minRows?: number; seed?: number } = {},
): Promise<LearnedTrader | null> {
  const traced = traceTrades(trades, plan, fr);
  const rows: BoostingRow[] = [];
  let sells = 0;
  for (const t of traced) {
    for (const k of t.ticks) {
      const sell = k.exitPct > t.plan.returnPct ? 1 : 0;
      sells += sell;
      rows.push({ anchorAt: t.trade.alertAt, tokenId: t.trade.id, features: k.features, labelValue: sell });
    }
  }
  if (rows.length < (opts.minRows ?? 500) || sells === 0 || sells === rows.length) return null;
  const model = await trainBoostedCurator(rows, {
    objective: "logistic",
    featureNames: LEARNED_TRADER_FEATURES,
    bagSeeds: 1,
    maxTrees: 200,
    runWeightPerDoubling: 0,
    seed: opts.seed ?? 1,
  });
  const odds = oddsOf(model, traced);
  // The plan alone unless a cut beats it on the training coins by more than noise.
  const alone = traced.map((t) => t.plan);
  let best = { cut: Infinity, mean: meanReturn(alone), results: alone };
  for (const cut of CUTS) {
    if (cut === Infinity) continue;
    const results = traced.map((t, i) => resultAtCut(t, odds[i]!, cut));
    const m = meanReturn(results);
    if (m > best.mean + MIN_GAIN_PCT) best = { cut, mean: m, results };
  }
  return {
    model,
    cut: best.cut,
    plan,
    rows: rows.length,
    sellShare: sells / rows.length,
    train: summarizeLab(best.results),
  };
}

/** The trader's results on `trades` (fast path over a trace of the plan alone). */
export function scoreLearnedTrader(
  trader: LearnedTrader,
  trades: readonly LabTrade[],
  fr: LabFrictions,
): LabResult[] {
  const traced = traceTrades(trades, trader.plan, fr);
  const odds = oddsOf(trader.model, traced);
  return traced.map((t, i) => resultAtCut(t, odds[i]!, trader.cut));
}

/** The trader on one trade by a full replay, the model asked on each tick the plan holds. */
export function replayLearned(trader: LearnedTrader, trade: LabTrade, fr: LabFrictions): LabResult | null {
  return replayExitPlan(
    trade,
    trader.plan,
    fr,
    (tick) => scoreBoosted(trader.model, learnedTraderFeatures(trade, tick)) >= trader.cut,
  );
}
