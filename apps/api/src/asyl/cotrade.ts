import { prisma } from "@trenchscanner/core";
import { COTRADE_COINS, COTRADE_WINDOW_MS } from "./graph.js";

/**
 * The trades behind a "bought together" link (user ask 2026-10-25): every coin of the wallet's
 * latest COTRADE_COINS that the other wallet also bought within COTRADE_WINDOW_MS, with both sides'
 * buys, sells, sizes and exits, and what they add up to. Stored data only, one query.
 */

/** Trades kept per wallet per coin in the answer: the timeline shows the start of each. */
export const PAIR_TRADES_MAX = 40;

/** [ms, 1 buy / -1 sell, SOL, tokens], as core's tradeTape stores them. */
export type PairTrade = [number, 1 | -1, number, number];

export interface PairSide {
  firstBuyAt: string;
  firstSellAt: string | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** solOut - solIn: realised, so a wallet still holding shows its spend as a loss. */
  netSol: number;
  boughtPct: number | null;
  firstBuyerRank: number | null;
  sniper: boolean;
  fastExit: boolean;
  trades: PairTrade[];
}

export interface PairCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  launchedAt: string | null;
  a: PairSide;
  b: PairSide;
  /** b's first buy minus a's, in seconds: negative when b bought first. */
  leadSec: number;
  /** b's first sell minus a's, when both sold. */
  exitLeadSec: number | null;
}

export interface PairSummary {
  coins: number;
  /** The wallet's coins the search read. */
  of: number;
  medianGapSec: number | null;
  /** Coins each bought first; ties (same second) in neither. */
  aFirst: number;
  bFirst: number;
  /** Median of b's spend over a's, per coin. */
  sizeRatio: number | null;
  solInA: number;
  solInB: number;
  netA: number;
  netB: number;
  /** Coins where both took out more than they put in. */
  bothUp: number;
  /** Coins both sold, and the median seconds between their first sells. */
  bothSold: number;
  medianExitGapSec: number | null;
}

export interface PairRead {
  a: string;
  b: string;
  windowSec: number;
  coins: PairCoin[];
  summary: PairSummary;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

type Row = {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  launchedAt: Date | null;
  of: number;
} & Record<`${"a" | "b"}_${keyof RowSide}`, unknown>;

interface RowSide {
  firstBuyAt: Date;
  firstSellAt: Date | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  boughtPct: number | null;
  firstBuyerRank: number | null;
  launchSniper: boolean;
  fastExit: boolean;
  trades: unknown;
}

function side(r: Row, p: "a" | "b"): PairSide {
  const g = <K extends keyof RowSide>(k: K) => r[`${p}_${k}`] as RowSide[K];
  const solIn = Number(g("solIn")) || 0;
  const solOut = Number(g("solOut")) || 0;
  const trades = Array.isArray(g("trades"))
    ? (g("trades") as unknown[])
        .filter(
          (t): t is PairTrade =>
            Array.isArray(t) && t.length >= 3 && typeof t[0] === "number" && (t[1] === 1 || t[1] === -1),
        )
        .slice(0, PAIR_TRADES_MAX)
        .map((t) => [t[0], t[1], round(Number(t[2]) || 0), Math.round(Number(t[3]) || 0)] as PairTrade)
    : [];
  return {
    firstBuyAt: g("firstBuyAt").toISOString(),
    firstSellAt: g("firstSellAt")?.toISOString() ?? null,
    buys: g("buys"),
    sells: g("sells"),
    solIn: round(solIn),
    solOut: round(solOut),
    netSol: round(solOut - solIn),
    boughtPct: g("boughtPct"),
    firstBuyerRank: g("firstBuyerRank"),
    sniper: g("launchSniper"),
    fastExit: g("fastExit"),
    trades,
  };
}

export async function loadPair(a: string, b: string): Promise<PairRead> {
  const windowSec = COTRADE_WINDOW_MS / 1000;
  // Each wallet's latest row per coin (a coin read twice keeps its newer tape).
  const rows = await prisma.$queryRaw<Row[]>`
    WITH mine AS (
      SELECT DISTINCT ON ("tokenId") *
        FROM "TokenWalletActivity"
       WHERE "wallet" = ${a} AND "buys" > 0 AND "firstBuyAt" IS NOT NULL
       ORDER BY "tokenId", "createdAt" DESC
    ), latest AS (
      SELECT * FROM mine ORDER BY "firstBuyAt" DESC LIMIT ${COTRADE_COINS}
    ), theirs AS (
      SELECT DISTINCT ON ("tokenId") o.*
        FROM "TokenWalletActivity" o
        JOIN latest m ON m."tokenId" = o."tokenId"
       WHERE o."wallet" = ${b} AND o."buys" > 0 AND o."firstBuyAt" IS NOT NULL
         AND o."firstBuyAt" BETWEEN m."firstBuyAt" - make_interval(secs => ${windowSec})
                                AND m."firstBuyAt" + make_interval(secs => ${windowSec})
       ORDER BY o."tokenId", o."createdAt" DESC
    )
    SELECT t."mintAddress" AS mint, t."symbol", t."name", t."imageUrl" AS image, t."launchedAt" AS "launchedAt",
           (SELECT COUNT(*)::int FROM latest) AS of,
           x."firstBuyAt" AS "a_firstBuyAt", x."firstSellAt" AS "a_firstSellAt", x."buys" AS "a_buys",
           x."sells" AS "a_sells", x."solIn" AS "a_solIn", x."solOut" AS "a_solOut",
           x."boughtPct" AS "a_boughtPct", x."firstBuyerRank" AS "a_firstBuyerRank",
           x."launchSniper" AS "a_launchSniper", x."fastExit" AS "a_fastExit", x."trades" AS "a_trades",
           y."firstBuyAt" AS "b_firstBuyAt", y."firstSellAt" AS "b_firstSellAt", y."buys" AS "b_buys",
           y."sells" AS "b_sells", y."solIn" AS "b_solIn", y."solOut" AS "b_solOut",
           y."boughtPct" AS "b_boughtPct", y."firstBuyerRank" AS "b_firstBuyerRank",
           y."launchSniper" AS "b_launchSniper", y."fastExit" AS "b_fastExit", y."trades" AS "b_trades"
      FROM latest x
      JOIN theirs y ON y."tokenId" = x."tokenId"
      JOIN "Token" t ON t."id" = x."tokenId"
     ORDER BY x."firstBuyAt" DESC`;
  const coins: PairCoin[] = rows.map((r) => {
    const sa = side(r, "a");
    const sb = side(r, "b");
    const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
    const exit = ms(sb.firstSellAt) - ms(sa.firstSellAt);
    return {
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      image: r.image,
      launchedAt: r.launchedAt?.toISOString() ?? null,
      a: sa,
      b: sb,
      leadSec: Math.round((ms(sb.firstBuyAt) - ms(sa.firstBuyAt)) / 1000),
      exitLeadSec: Number.isFinite(exit) ? Math.round(exit / 1000) : null,
    };
  });
  return { a, b, windowSec, coins, summary: summarise(coins, rows[0]?.of ?? 0) };
}

export function summarise(coins: readonly PairCoin[], of: number): PairSummary {
  const sum = (f: (c: PairCoin) => number) => round(coins.reduce((s, c) => s + f(c), 0));
  const exits = coins.flatMap((c) => (c.exitLeadSec === null ? [] : [Math.abs(c.exitLeadSec)]));
  const ratios = coins.flatMap((c) => (c.a.solIn > 0 && c.b.solIn > 0 ? [c.b.solIn / c.a.solIn] : []));
  const ratio = median(ratios);
  return {
    coins: coins.length,
    of,
    medianGapSec: median(coins.map((c) => Math.abs(c.leadSec))),
    aFirst: coins.filter((c) => c.leadSec > 0).length,
    bFirst: coins.filter((c) => c.leadSec < 0).length,
    sizeRatio: ratio === null ? null : round(ratio, 2),
    solInA: sum((c) => c.a.solIn),
    solInB: sum((c) => c.b.solIn),
    netA: sum((c) => c.a.netSol),
    netB: sum((c) => c.b.netSol),
    bothUp: coins.filter((c) => c.a.netSol > 0 && c.b.netSol > 0).length,
    bothSold: exits.length,
    medianExitGapSec: median(exits),
  };
}
