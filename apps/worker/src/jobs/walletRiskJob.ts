import { prisma, createLogger, walletRiskScore, RISKY_WALLET_SCORE } from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("wallet-risk");

/**
 * Rebuilds every wallet's risk score (WalletRisk) from the trade tape's per-wallet rows
 * (TokenWalletActivity, written by tradeTapeJob.ts), hourly. A tape is read only once its call's
 * row is final, so every coin counted here had its outcome settled before this rebuild - which is
 * what keeps a score the scan reads at a decision from carrying that coin's own result.
 *
 * Wallets seen in fewer than MIN_APPEARANCES coins are left out (most wallets; their score would
 * be the prior). The table is replaced whole, in one transaction.
 */

const MIN_APPEARANCES = 2;
const INSERT_CHUNK = 5_000;

interface Agg {
  wallet: string;
  appearances: number;
  dumps: number;
  fastExits: number;
  snipes: number;
  medianSupplyPct: number | null;
  solIn: number;
  solOut: number;
  lastSeenAt: Date;
}

export async function runWalletRiskJob(opts: { now?: () => number } = {}): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  // The market's dump rate, over every wallet, the once-seen ones included.
  const [totals] = await prisma.$queryRaw<{ appearances: bigint; dumps: bigint }[]>`
    SELECT COUNT(*) FILTER (WHERE a."buys" > 0) AS appearances,
           COUNT(*) FILTER (WHERE a."buys" > 0 AND a."dumpedIntoStop") AS dumps
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')`;
  const appearances = Number(totals?.appearances ?? 0);
  const marketDumpRate = appearances > 0 ? Number(totals!.dumps) / appearances : 0;

  const rows = await prisma.$queryRaw<
    (Omit<Agg, "appearances" | "dumps" | "fastExits" | "snipes"> & {
      appearances: bigint;
      dumps: bigint;
      fastExits: bigint;
      snipes: bigint;
    })[]
  >`
    SELECT a."wallet",
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           COUNT(*) FILTER (WHERE a."fastExit") AS "fastExits",
           COUNT(*) FILTER (WHERE a."launchSniper") AS snipes,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a."boughtPct") AS "medianSupplyPct",
           SUM(a."solIn") AS "solIn",
           SUM(a."solOut") AS "solOut",
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
    return {
      wallet: r.wallet,
      score: walletRiskScore(stats, marketDumpRate),
      ...stats,
      medianSupplyPct: r.medianSupplyPct === null ? null : Number(r.medianSupplyPct),
      solIn: Number(r.solIn),
      solOut: Number(r.solOut),
      lastSeenAt: r.lastSeenAt,
      computedAt: now,
    };
  });

  await prisma.$transaction(
    async (tx) => {
      await tx.walletRisk.deleteMany({});
      for (let i = 0; i < data.length; i += INSERT_CHUNK) {
        await tx.walletRisk.createMany({ data: data.slice(i, i + INSERT_CHUNK) });
      }
    },
    { timeout: 120_000 },
  );

  const meta: JobRunMeta = {
    wallets: data.length,
    risky: data.filter((d) => d.score >= RISKY_WALLET_SCORE).length,
    marketDumpRate: Math.round(marketDumpRate * 10_000) / 10_000,
    appearances,
  };
  logger.info("wallet risk rebuilt", meta);
  return meta;
}
