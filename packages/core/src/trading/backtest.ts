import { prisma } from "../db.js";

/**
 * What the bot's model sources would have bought over the last days, read from the graded
 * alerts: per model, every call, its high-conviction calls, and the calls the AI judge called a
 * buy - how many, how many doubled in the win window (CuratedAlert.hit2xIn1h, the project's
 * verdict), and the average return under the default exit plan (simReturnPct). Lets an admin
 * pick sources and the AI gate from evidence before the bot trades a lamport.
 */

export interface BacktestSlice {
  /** Graded calls (outcome final). */
  calls: number;
  /** Of those, how many doubled in the win window. */
  wins: number;
  /** wins / calls, 0-1; null with no calls. */
  hitRate: number | null;
  /** Mean return under the default exit plan, in percent; null when none was simulated. */
  avgReturnPct: number | null;
}

export interface BacktestRow {
  model: string;
  name: string;
  all: BacktestSlice;
  high: BacktestSlice;
  aiBuy: BacktestSlice;
  /** High-conviction calls the AI judge also called a buy. */
  highAiBuy: BacktestSlice;
}

export interface BacktestCall {
  model: string;
  modelName: string | null;
  tier: string | null;
  hit2x: boolean | null;
  simReturnPct: number | null;
  aiDecision: string | null;
}

function slice(calls: BacktestCall[]): BacktestSlice {
  const graded = calls.filter((c) => c.hit2x !== null);
  const wins = graded.filter((c) => c.hit2x).length;
  const returns = graded.map((c) => c.simReturnPct).filter((r): r is number => r !== null);
  return {
    calls: graded.length,
    wins,
    hitRate: graded.length > 0 ? wins / graded.length : null,
    avgReturnPct: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
  };
}

/**
 * The canonical win (curation/labels.ts): a 2x with no 50% stop first. `hit2xIn1h` alone is true
 * on stopped-out calls too, so the disqualified flag has to come off it.
 */
export function backtestHit2x(hit2xIn1h: boolean | null, disqualified: boolean | null): boolean | null {
  return hit2xIn1h === null ? null : hit2xIn1h && disqualified !== true;
}

/** Groups graded calls into per-model slices, busiest model first. */
export function summarizeBacktest(calls: BacktestCall[]): BacktestRow[] {
  const byModel = new Map<string, BacktestCall[]>();
  for (const c of calls) byModel.set(c.model, [...(byModel.get(c.model) ?? []), c]);
  return [...byModel.entries()]
    .map(([model, list]) => ({
      model,
      name: list.find((c) => c.modelName)?.modelName ?? model,
      all: slice(list),
      high: slice(list.filter((c) => c.tier === "high")),
      aiBuy: slice(list.filter((c) => c.aiDecision === "buy")),
      highAiBuy: slice(list.filter((c) => c.tier === "high" && c.aiDecision === "buy")),
    }))
    .sort((a, b) => b.all.calls - a.all.calls);
}

/** The graded model calls of the last `days`, with the AI judge's verdict on each, summarized. */
export async function tradingBacktest(days: number, now: Date = new Date()): Promise<BacktestRow[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.curatedAlert.findMany({
    where: { createdAt: { gte: since }, model: { not: null }, hit2xIn1h: { not: null } },
    select: {
      model: true,
      modelName: true,
      tier: true,
      hit2xIn1h: true,
      disqualified: true,
      simReturnPct: true,
      aiReviews: {
        where: { decision: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { decision: true },
      },
    },
  });
  return summarizeBacktest(
    rows.map((r) => ({
      model: r.model!,
      modelName: r.modelName,
      tier: r.tier,
      hit2x: backtestHit2x(r.hit2xIn1h, r.disqualified),
      simReturnPct: r.simReturnPct,
      aiDecision: r.aiReviews[0]?.decision ?? null,
    })),
  );
}
