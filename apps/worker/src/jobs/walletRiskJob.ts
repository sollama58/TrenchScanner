import {
  prisma,
  createLogger,
  walletRiskScore,
  walletWinScore,
  walletLabels,
  RISKY_WALLET_SCORE,
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
 * The win side (user ask 2026-10-13): a coin counts as a win when its reference row (the tape's
 * outcome) hit 2x within 15 minutes and was not disqualified; an early win is one the wallet
 * first bought before that row's anchor, so a decision could have seen it holding. The win score
 * (walletWinScore) is built from those against the market's win rate, the way the risk score is
 * built from dumps.
 */

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
           COUNT(*) FILTER (WHERE a."buys" > 0 AND co."hit2xIn15m" AND NOT co."disqualified") AS wins
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    LEFT JOIN "CandidateOutcome" co ON co."id" = t."outcomeId"`;
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
           COUNT(*) FILTER (WHERE co."hit2xIn15m" AND NOT co."disqualified") AS wins,
           COUNT(*) FILTER (WHERE co."hit2xIn15m" AND NOT co."disqualified"
                              AND a."firstBuyAt" IS NOT NULL AND a."firstBuyAt" < t."anchorAt") AS "earlyWins",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a."boughtPct") AS "medianSupplyPct",
           SUM(a."solIn") AS "solIn",
           SUM(a."solOut") AS "solOut",
           MAX(COALESCE(a."firstBuyAt", a."createdAt")) AS "lastSeenAt"
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    LEFT JOIN "CandidateOutcome" co ON co."id" = t."outcomeId"
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

  const { written, deleted } = await prisma.$transaction((tx) => replaceRows(tx, WALLET_RISK_TABLE, data), {
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
