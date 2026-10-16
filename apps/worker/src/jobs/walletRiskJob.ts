import {
  prisma,
  Prisma,
  createLogger,
  walletRiskScore,
  walletWinScore,
  walletLabels,
  MIN_WIN_SOL,
  OVERSOLD_TOKENS,
  RISKY_WALLET_SCORE,
  WALLET_WIN_MULTIPLE,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";
import { replaceRows, type ReplaceRowsSpec } from "./replaceRows.js";

const logger = createLogger("wallet-risk");

/**
 * Rebuilds every wallet's risk score (WalletRisk) from the trade tape's per-wallet rows
 * (TokenWalletActivity, written by tradeTapeJob.ts), hourly. A tape is read only once its call's
 * row is final, so every coin counted here had its outcome settled before this rebuild - which is
 * what keeps a score the scan reads at a decision from carrying that coin's own result.
 *
 * Wallets seen in fewer than MIN_APPEARANCES coins are left out (most wallets; their score would
 * be the prior). The table is brought to the new set in one transaction, writing only the rows
 * whose figures changed (replaceRows.ts): computedAt is the run that last changed a row, and the
 * time of the last rebuild is the job's heartbeat (readers show the later of the two).
 *
 * The win side (user ask 2026-10-13): a coin counts as a win when the wallet's own trade in it
 * came out at WALLET_WIN_MULTIPLE or better for MIN_WIN_SOL of profit, on a clean trade (winSql below;
 * the definition and why it changed on 2026-10-16 are at MIN_WIN_SOL in core's riskScore.ts); an
 * early win is one the wallet first bought before the tape's anchor, so a decision could have seen
 * it holding. The win score (walletWinScore) is built from those against the market's win rate,
 * the way the risk score is built from dumps.
 */

/** A win: the wallet's own clean trade at WALLET_WIN_MULTIPLE or better, for MIN_WIN_SOL of profit. */
const winSql = Prisma.sql`(a."solIn" > 0
  AND a."solOut" >= ${WALLET_WIN_MULTIPLE} * a."solIn"
  AND a."solOut" - a."solIn" >= ${MIN_WIN_SOL}
  AND a."tokensSold" <= ${OVERSOLD_TOKENS} * a."tokensBought"
  AND NOT (a."firstSellAt" IS NOT NULL AND a."firstBuyAt" IS NOT NULL AND a."firstSellAt" < a."firstBuyAt"))`;

const MIN_APPEARANCES = 2;

const WALLET_RISK_TABLE: ReplaceRowsSpec = {
  table: "WalletRisk",
  key: "wallet",
  columns: [
    { name: "wallet", type: "text" },
    { name: "score", type: "double precision" },
    { name: "appearances", type: "integer" },
    { name: "dumps", type: "integer" },
    { name: "fastExits", type: "integer" },
    { name: "snipes", type: "integer" },
    { name: "wins", type: "integer" },
    { name: "earlyWins", type: "integer" },
    { name: "winScore", type: "double precision" },
    { name: "dumper", type: "boolean" },
    { name: "winner", type: "boolean" },
    { name: "sniper", type: "boolean" },
    { name: "medianSupplyPct", type: "double precision" },
    { name: "solIn", type: "double precision" },
    { name: "solOut", type: "double precision" },
    { name: "lastSeenAt", type: "timestamp(3)" },
    { name: "computedAt", type: "timestamp(3)" },
  ],
  stampColumns: ["computedAt"],
};

interface Agg {
  wallet: string;
  appearances: number;
  dumps: number;
  fastExits: number;
  snipes: number;
  wins: number;
  earlyWins: number;
  medianSupplyPct: number | null;
  solIn: number;
  solOut: number;
  lastSeenAt: Date;
}

export async function runWalletRiskJob(opts: { now?: () => number } = {}): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  // The market's dump rate, over every wallet, the once-seen ones included.
  const [totals] = await prisma.$queryRaw<{ appearances: bigint; dumps: bigint; wins: bigint }[]>`
    SELECT COUNT(*) FILTER (WHERE a."buys" > 0) AS appearances,
           COUNT(*) FILTER (WHERE a."buys" > 0 AND a."dumpedIntoStop") AS dumps,
           COUNT(*) FILTER (WHERE a."buys" > 0 AND ${winSql}) AS wins
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')`;
  const appearances = Number(totals?.appearances ?? 0);
  const marketDumpRate = appearances > 0 ? Number(totals!.dumps) / appearances : 0;
  const marketWinRate = appearances > 0 ? Number(totals!.wins) / appearances : 0;

  const rows = await prisma.$queryRaw<
    (Omit<Agg, "appearances" | "dumps" | "fastExits" | "snipes" | "wins" | "earlyWins"> & {
      appearances: bigint;
      dumps: bigint;
      fastExits: bigint;
      snipes: bigint;
      wins: bigint;
      earlyWins: bigint;
    })[]
  >`
    SELECT a."wallet",
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           COUNT(*) FILTER (WHERE a."fastExit") AS "fastExits",
           COUNT(*) FILTER (WHERE a."launchSniper") AS snipes,
           COUNT(*) FILTER (WHERE ${winSql}) AS wins,
           COUNT(*) FILTER (WHERE ${winSql}
                              AND a."firstBuyAt" IS NOT NULL AND a."firstBuyAt" < t."anchorAt") AS "earlyWins",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a."boughtPct") AS "medianSupplyPct",
           -- Summed as numeric: float8 addition depends on the order the rows arrive in, so a
           -- plan change (an index walk one hour, a scan the next) moved the last bits of 13-25%
           -- of wallets' sums and replaceRows rewrote those rows for nothing.
           SUM(a."solIn"::numeric)::float8 AS "solIn",
           SUM(a."solOut"::numeric)::float8 AS "solOut",
           MAX(COALESCE(a."firstBuyAt", a."createdAt")) AS "lastSeenAt"
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    WHERE a."buys" > 0
    GROUP BY a."wallet"
    HAVING COUNT(*) >= ${MIN_APPEARANCES}`;

  const data = rows.map((r) => {
    const stats = {
      appearances: Number(r.appearances),
      dumps: Number(r.dumps),
      fastExits: Number(r.fastExits),
      snipes: Number(r.snipes),
    };
    const wins = { appearances: stats.appearances, wins: Number(r.wins), earlyWins: Number(r.earlyWins) };
    const labels = walletLabels(
      { appearances: stats.appearances, dumps: stats.dumps, wins: wins.wins, snipes: stats.snipes },
      { dumpRate: marketDumpRate, winRate: marketWinRate },
    );
    return {
      wallet: r.wallet,
      score: walletRiskScore(stats, marketDumpRate),
      ...stats,
      wins: wins.wins,
      earlyWins: wins.earlyWins,
      winScore: walletWinScore(wins, marketWinRate),
      ...labels,
      medianSupplyPct: r.medianSupplyPct === null ? null : Number(r.medianSupplyPct),
      solIn: Number(r.solIn),
      solOut: Number(r.solOut),
      lastSeenAt: r.lastSeenAt,
      computedAt: now,
    };
  });

  // maxWait above Prisma's 2-s default: this runs on the trainer's pool of six, which the other
  // hourly jobs share on the same minute, and a pool timeout here throws away the aggregate just
  // paid for.
  const { written, deleted } = await prisma.$transaction((tx) => replaceRows(tx, WALLET_RISK_TABLE, data), {
    maxWait: 30_000,
    timeout: 120_000,
  });

  const meta: JobRunMeta = {
    wallets: data.length,
    written,
    removed: deleted,
    risky: data.filter((d) => d.score >= RISKY_WALLET_SCORE).length,
    dumpers: data.filter((d) => d.dumper).length,
    winners: data.filter((d) => d.winner).length,
    snipers: data.filter((d) => d.sniper).length,
    marketDumpRate: Math.round(marketDumpRate * 10_000) / 10_000,
    marketWinRate: Math.round(marketWinRate * 10_000) / 10_000,
    appearances,
  };
  logger.info("wallet risk rebuilt", meta);
  return meta;
}
