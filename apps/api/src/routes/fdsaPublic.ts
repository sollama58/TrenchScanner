import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  FDSA_DESK_ID,
  FDSA_HARD_FLOOR_MULTIPLE,
  paperStats,
  prisma,
  readFdsaExitPlan,
  type FdsaExitPlan,
} from "@trenchscanner/core";
import { SharedCacheMap, withComputedAt } from "../sharedCache.js";
import { ensureFdsaDesk, fdsaRecord, hit2xOf, outcomesById, pnl } from "./fdsa.js";

/**
 * The #fdsa page for users (user ask 2026-11-01: "make the FDSA page informational and
 * user-facing"): how Claude's paper desk is doing - its P&L, its hit rate on the goal metric next
 * to the pool's, the funnel from every alert to a buy, its open and closed trades, and how its
 * adaptive exits played out against the default ladder.
 *
 * Read-only, and only what a reader can see on any other tab: no spend, no budget, no model,
 * effort or prompt version, no reasoning or brief, no controls, no worker internals and no
 * error text. The controls and those figures are Admin > FDSA (routes/fdsa.ts, admin wallets
 * only). Behind authenticateSubscriber like the curated feed: an open position is a real-time
 * call, which is what access buys (guests see the feed 5 minutes late, routes/guest.ts).
 */

/** Every reader gets the same page, so one fill serves them all; trades move on a 10 s pass. */
const CACHE_TTL_MS = 15_000;
const STALE_MS = 60_000;
const MAX_CLOSED_SHOWN = 60;
/** The equity curve's points: every closed trade since the bankroll's reset, newest last. */
const MAX_CURVE_POINTS = 400;
const DAY_MS = 86_400_000;

const querySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
    .default(30),
});

const sol = (lamports: bigint) => Number(lamports) / 1e9;

/** The plan as a reader sees it: the validated parameters, never the model's raw proposal. */
const planView = (raw: unknown): FdsaExitPlan | null => readFdsaExitPlan(raw);

export async function registerFdsaPublicRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticateSubscriber);
  const caches = new SharedCacheMap<FdsaPage>(CACHE_TTL_MS, 3, STALE_MS);
  app.get("/", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "days must be 7, 30 or 90" });
    const days = parsed.data.days;
    return withComputedAt(await caches.for(String(days)).getStamped(() => buildFdsaPage(days)));
  });
}

export type FdsaPage = Awaited<ReturnType<typeof buildFdsaPage>>;

export async function buildFdsaPage(days: number) {
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const desk = await ensureFdsaDesk();
  const [record, open, closed, bankrollTrades, revisionRows, reasonRows] = await Promise.all([
    fdsaRecord(days),
    prisma.fdsaPosition.findMany({
      where: { deskId: FDSA_DESK_ID, status: "open" },
      orderBy: { openedAt: "desc" },
      include: { fills: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.fdsaPosition.findMany({
      where: { deskId: FDSA_DESK_ID, status: { not: "open" }, closedAt: { gt: since } },
      orderBy: { closedAt: "desc" },
      take: MAX_CLOSED_SHOWN,
      include: { fills: { orderBy: { createdAt: "asc" } } },
    }),
    // The bankroll's own trades: a reset starts a new one, and its P&L counts from there.
    prisma.fdsaPosition.findMany({
      where: { deskId: FDSA_DESK_ID, openedAt: { gte: desk.resetAt } },
      select: {
        status: true,
        swapInLamports: true,
        feesLamports: true,
        proceedsLamports: true,
        tokensBought: true,
        tokensHeld: true,
        lastMultiple: true,
        closedAt: true,
        candidateOutcomeId: true,
      },
    }),
    // How the plans moved while held: the milestone check-ins and what came of them.
    prisma.fdsaPlanRevision.groupBy({
      by: ["trigger", "status"],
      where: { createdAt: { gt: since }, position: { deskId: FDSA_DESK_ID } },
      _count: { _all: true },
    }),
    // Every sale by why it sold, with the share of the position each sold.
    prisma.fdsaFill.findMany({
      where: { side: "sell", createdAt: { gt: since }, position: { deskId: FDSA_DESK_ID } },
      select: { reason: true, multiple: true },
    }),
  ]);

  const [outcomes, tokens] = await Promise.all([
    outcomesById([...open, ...closed, ...bankrollTrades].map((p) => p.candidateOutcomeId)),
    // The coin's name and picture, as every card on the site shows them.
    prisma.token.findMany({
      where: { mintAddress: { in: [...new Set([...open, ...closed].map((p) => p.mint))] } },
      select: { mintAddress: true, name: true, imageUrl: true },
    }),
  ]);
  const tokenOf = new Map(tokens.map((t) => [t.mintAddress, t]));
  const coin = (p: { mint: string; symbol: string | null }) => ({
    mint: p.mint,
    symbol: p.symbol,
    name: tokenOf.get(p.mint)?.name ?? null,
    imageUrl: tokenOf.get(p.mint)?.imageUrl ?? null,
  });
  const stats = paperStats(
    desk,
    bankrollTrades.map((p) => ({ ...p, hit2x: hit2xOf(outcomes.get(p.candidateOutcomeId ?? "")) })),
  );
  const bankroll = sol(desk.bankrollLamports);

  // Realized P&L after each close, as a share of the bankroll, then today's equity (open marked).
  const curve: { at: string; pnlSol: number }[] = [];
  let running = 0;
  for (const p of bankrollTrades
    .filter((t) => t.status !== "open" && t.closedAt)
    .sort((a, b) => a.closedAt!.getTime() - b.closedAt!.getTime())
    .slice(-MAX_CURVE_POINTS)) {
    running += sol(p.proceedsLamports - p.swapInLamports - p.feesLamports);
    curve.push({ at: p.closedAt!.toISOString(), pnlSol: running });
  }

  const fills = (p: (typeof open)[number]) =>
    p.fills.map((f) => ({
      side: f.side,
      reason: f.reason,
      multiple: f.multiple,
      sol: sol(f.lamports),
      at: f.createdAt,
    }));

  const byReason = new Map<string, { count: number; multiples: number[] }>();
  for (const f of reasonRows) {
    const r = byReason.get(f.reason) ?? { count: 0, multiples: [] };
    r.count++;
    if (f.multiple !== null) r.multiples.push(f.multiple);
    byReason.set(f.reason, r);
  }
  const triggers = new Map<string, { checks: number; changed: number }>();
  for (const r of revisionRows) {
    if (r.trigger === "entry") continue;
    const t = triggers.get(r.trigger) ?? { checks: 0, changed: 0 };
    t.checks += r._count._all;
    if (r.status === "applied") t.changed += r._count._all;
    triggers.set(r.trigger, t);
  }

  return {
    days,
    status: {
      mode: "paper" as const,
      active: desk.running,
      since: desk.resetAt,
      lastRunAt: desk.lastRunAt,
    },
    bankroll: {
      startSol: bankroll,
      equitySol: sol(stats.equityLamports),
      pnlSol: sol(stats.pnlLamports),
      pnlPct: bankroll > 0 ? (sol(stats.pnlLamports) / bankroll) * 100 : null,
      openValueSol: sol(stats.openValueLamports),
      trades: bankrollTrades.length,
      closed: stats.closed,
      profitable: stats.wins,
      curve,
    },
    record: {
      trades: record.trades,
      tradeVerdicts: record.decide.trade,
      passes: record.decide.pass,
      pool: record.pool,
      target: record.target,
    },
    funnel: {
      screened: record.pool.total,
      shortlisted: record.screen.shortlisted.total,
      decided: record.decide.trade.total + record.decide.pass.total,
      bought: record.trades.total,
      won: record.trades.wins,
    },
    ladder: {
      summary: record.ladder.summary,
      paired: record.ladder.paired,
      fdsaAvgPct: record.ladder.fdsaAvgPct,
      ladderAvgPct: record.ladder.ladderAvgPct,
      fdsaBetter: record.ladder.fdsaBetter,
    },
    exits: {
      hardFloorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
      byReason: [...byReason.entries()]
        .map(([reason, r]) => ({
          reason,
          count: r.count,
          avgMultiple:
            r.multiples.length > 0 ? r.multiples.reduce((s, m) => s + m, 0) / r.multiples.length : null,
        }))
        .sort((a, b) => b.count - a.count),
      checkIns: [...triggers.entries()].map(([trigger, t]) => ({ trigger, ...t })),
    },
    open: open.map((p) => ({
      id: p.id,
      ...coin(p),
      openedAt: p.openedAt,
      nowMultiple: p.lastMultiple,
      peakMultiple: p.peakMultiple,
      floorMultiple: Math.max(FDSA_HARD_FLOOR_MULTIPLE, p.floorMultiple),
      soldFraction: p.soldFraction,
      planVersion: p.planVersion,
      plan: planView(p.exitPlan),
      buySol: sol(p.swapInLamports + p.feesLamports),
      backSol: sol(p.proceedsLamports),
      fills: fills(p),
    })),
    closed: closed.map((p) => {
      const o = p.candidateOutcomeId ? outcomes.get(p.candidateOutcomeId) : undefined;
      const result = pnl(p);
      return {
        id: p.id,
        ...coin(p),
        openedAt: p.openedAt,
        closedAt: p.closedAt,
        holdMs: (p.closedAt ?? now).getTime() - p.openedAt.getTime(),
        pnlSol: Number(result.pnlLamports) / 1e9,
        pnlPct: result.pnlPct,
        peakMultiple: p.peakMultiple,
        planVersion: p.planVersion,
        closeReason: p.closeReason,
        hit2x: hit2xOf(o),
        ladderReturnPct: o?.simReturnPct ?? null,
        fills: fills(p),
      };
    }),
  };
}
