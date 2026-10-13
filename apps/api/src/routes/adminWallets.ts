import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  prisma,
  Prisma,
  RISKY_WALLET_SCORE,
  WINNER_WALLET_SCORE,
  STOP_ROLES,
  type StopCause,
  type StopRole,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";

/**
 * The Admin "Wallets" section (brief: notes/hit-catch-2026-10-13/wallet-risk-brief.md): the
 * riskiest wallets by their composite score (WalletRisk, rebuilt hourly by the trainer), one
 * wallet's coins, one coin's holders and first buyers with their scores, and what led the stops
 * over the last day (CandidateOutcome.stopCause, from the trade tape). Behind the admin wallet
 * check (registered under its preHandler in server.ts), read-only.
 */

const OVERVIEW_CACHE_MS = 60_000;
const DAY_MS = 24 * 3_600_000;

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address");
const walletSchema = z.object({ wallet: address });
const mintSchema = z.object({ mint: address });
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  minCoins: z.coerce.number().int().min(2).max(50).default(3),
});

export interface StopCauseSummary {
  hours: number;
  stops: number;
  /** Stops each role led (the largest share of the SOL sold). */
  led: Record<StopRole, number>;
  /** Each role's mean share of the selling, across the stops. */
  meanShare: Record<StopRole, number>;
  medianSellers: number | null;
}

/** Exported for tests. */
export function summarizeStopCauses(causes: readonly StopCause[], hours: number): StopCauseSummary {
  const led = Object.fromEntries(STOP_ROLES.map((r) => [r, 0])) as Record<StopRole, number>;
  const sum = Object.fromEntries(STOP_ROLES.map((r) => [r, 0])) as Record<StopRole, number>;
  const counted = causes.filter((c) => c.lead !== null);
  for (const c of counted) {
    led[c.lead!] += 1;
    for (const r of STOP_ROLES) sum[r] += c.shares[r] ?? 0;
  }
  const sellers = causes.map((c) => c.sellers).sort((a, b) => a - b);
  return {
    hours,
    stops: causes.length,
    led,
    meanShare: Object.fromEntries(
      STOP_ROLES.map((r) => [
        r,
        counted.length > 0 ? Math.round((sum[r] / counted.length) * 1000) / 1000 : 0,
      ]),
    ) as Record<StopRole, number>,
    medianSellers: sellers.length > 0 ? sellers[Math.floor(sellers.length / 2)]! : null,
  };
}

async function buildOverview(limit: number, minCoins: number) {
  const now = Date.now();
  const since = new Date(now - DAY_MS);
  const [wallets, winners, risky, winnerCount, newest, tapes, tapes24h, causes] = await Promise.all([
    prisma.walletRisk.findMany({
      where: { appearances: { gte: minCoins } },
      orderBy: [{ score: "desc" }, { appearances: "desc" }],
      take: limit,
    }),
    // The win side (user ask 2026-10-13): wallets that keep turning up early in coins that double.
    prisma.walletRisk.findMany({
      where: { appearances: { gte: minCoins }, wins: { gte: 1 } },
      orderBy: [{ winScore: "desc" }, { earlyWins: "desc" }, { appearances: "desc" }],
      take: limit,
    }),
    prisma.walletRisk.count({ where: { score: { gte: RISKY_WALLET_SCORE } } }),
    prisma.walletRisk.count({ where: { winScore: { gte: WINNER_WALLET_SCORE } } }),
    prisma.walletRisk.findFirst({ orderBy: { computedAt: "desc" }, select: { computedAt: true } }),
    prisma.tokenTradeTape.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.tokenTradeTape.groupBy({
      by: ["status", "source"],
      where: { readAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.candidateOutcome.findMany({
      where: { anchorAt: { gte: since }, stopCause: { not: Prisma.DbNull } },
      select: { stopCause: true },
    }),
  ]);
  return {
    computedAt: newest?.computedAt ?? null,
    scoredWallets: await prisma.walletRisk.count(),
    riskyWallets: risky,
    riskyScore: RISKY_WALLET_SCORE,
    winnerWallets: winnerCount,
    winnerScore: WINNER_WALLET_SCORE,
    tapes: Object.fromEntries(tapes.map((t) => [t.status, t._count._all])),
    tapes24h: tapes24h.map((t) => ({ status: t.status, source: t.source, count: t._count._all })),
    stopCauses: summarizeStopCauses(
      causes.map((c) => c.stopCause as unknown as StopCause).filter((c) => c && c.v === 1),
      24,
    ),
    wallets: wallets.map(walletRow),
    winners: winners.map(walletRow),
  };
}

const walletRow = (w: {
  wallet: string;
  score: number;
  appearances: number;
  dumps: number;
  fastExits: number;
  snipes: number;
  wins: number;
  earlyWins: number;
  winScore: number;
  medianSupplyPct: number | null;
  solIn: number;
  solOut: number;
  lastSeenAt: Date;
}) => ({
  wallet: w.wallet,
  score: w.score,
  appearances: w.appearances,
  dumps: w.dumps,
  fastExits: w.fastExits,
  snipes: w.snipes,
  wins: w.wins,
  earlyWins: w.earlyWins,
  winScore: w.winScore,
  medianSupplyPct: w.medianSupplyPct,
  solIn: w.solIn,
  solOut: w.solOut,
  lastSeenAt: w.lastSeenAt,
});

const roleList = (a: {
  isCreator: boolean;
  firstBuyerRank: number | null;
  launchSniper: boolean;
  top10AtAnchor: boolean;
  fastExit: boolean;
  dumpedIntoStop: boolean;
}) =>
  [
    a.isCreator && "creator",
    a.launchSniper && "sniper",
    a.firstBuyerRank !== null && `buyer #${a.firstBuyerRank}`,
    a.top10AtAnchor && "top 10",
    a.fastExit && "fast exit",
    a.dumpedIntoStop && "sold into stop",
  ].filter((r): r is string => typeof r === "string");

async function walletDetail(wallet: string) {
  const [risk, activity] = await Promise.all([
    prisma.walletRisk.findUnique({ where: { wallet } }),
    prisma.tokenWalletActivity.findMany({
      where: { wallet },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { token: { select: { mintAddress: true, symbol: true, tradeTape: true } } },
    }),
  ]);
  const outcomeIds = activity.map((a) => a.token.tradeTape?.outcomeId).filter((id): id is string => !!id);
  const outcomes = new Map(
    (
      await prisma.candidateOutcome.findMany({
        where: { id: { in: outcomeIds } },
        select: { id: true, hit2xIn1h: true, disqualified: true, stoppedAt: true, peak1hReturnPct: true },
      })
    ).map((o) => [o.id, o]),
  );
  return {
    wallet,
    risk,
    coins: activity.map((a) => {
      const o = a.token.tradeTape?.outcomeId ? outcomes.get(a.token.tradeTape.outcomeId) : undefined;
      return {
        mint: a.token.mintAddress,
        symbol: a.token.symbol,
        reason: a.token.tradeTape?.reason ?? null,
        anchorAt: a.token.tradeTape?.anchorAt ?? null,
        outcome: o ? (o.hit2xIn1h && !o.disqualified ? "win" : o.stoppedAt ? "stop" : "fizzle") : null,
        solIn: a.solIn,
        solOut: a.solOut,
        boughtPct: a.boughtPct,
        heldPctAtAnchor: a.heldPctAtAnchor,
        dumpSol: a.dumpSol,
        roles: roleList(a),
      };
    }),
  };
}

async function coinDetail(mint: string) {
  const token = await prisma.token.findUnique({
    where: { mintAddress: mint },
    select: { id: true, symbol: true, tradeTape: true },
  });
  if (!token) return null;
  const activity = await prisma.tokenWalletActivity.findMany({
    where: {
      tokenId: token.id,
      OR: [
        { top10AtAnchor: true },
        { firstBuyerRank: { not: null } },
        { isCreator: true },
        { dumpedIntoStop: true },
      ],
    },
  });
  const scores = new Map(
    (
      await prisma.walletRisk.findMany({
        where: { wallet: { in: activity.map((a) => a.wallet) } },
        select: { wallet: true, score: true, appearances: true, winScore: true, earlyWins: true },
      })
    ).map((w) => [w.wallet, w]),
  );
  const ref = token.tradeTape?.outcomeId
    ? await prisma.candidateOutcome.findUnique({
        where: { id: token.tradeTape.outcomeId },
        select: { stopCause: true, hit2xIn1h: true, stoppedAt: true },
      })
    : null;
  return {
    mint,
    symbol: token.symbol,
    tape: token.tradeTape,
    stopCause: ref?.stopCause ?? null,
    wallets: activity
      .map((a) => ({
        wallet: a.wallet,
        score: scores.get(a.wallet)?.score ?? null,
        winScore: scores.get(a.wallet)?.winScore ?? null,
        earlyWins: scores.get(a.wallet)?.earlyWins ?? null,
        coins: scores.get(a.wallet)?.appearances ?? null,
        firstBuyerRank: a.firstBuyerRank,
        heldPctAtAnchor: a.heldPctAtAnchor,
        boughtPct: a.boughtPct,
        solIn: a.solIn,
        solOut: a.solOut,
        dumpSol: a.dumpSol,
        roles: roleList(a),
      }))
      .sort((a, b) => (b.heldPctAtAnchor ?? 0) - (a.heldPctAtAnchor ?? 0)),
  };
}

export async function registerAdminWalletRoutes(app: FastifyInstance) {
  const overview = new Map<string, SharedCache<Awaited<ReturnType<typeof buildOverview>>>>();
  app.get("/wallets", async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const key = `${parsed.data.limit}:${parsed.data.minCoins}`;
    let cache = overview.get(key);
    if (!cache) {
      if (overview.size > 16) overview.clear();
      cache = new SharedCache(OVERVIEW_CACHE_MS);
      overview.set(key, cache);
    }
    return cache.get(() => buildOverview(parsed.data.limit, parsed.data.minCoins));
  });

  app.get("/wallets/coin/:mint", async (request, reply) => {
    const parsed = mintSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const out = await coinDetail(parsed.data.mint);
    if (!out) return reply.code(404).send({ error: "no such coin" });
    return out;
  });

  app.get("/wallets/:wallet", async (request, reply) => {
    const parsed = walletSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return walletDetail(parsed.data.wallet);
  });
}
