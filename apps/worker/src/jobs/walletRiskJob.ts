import {
  prisma,
  Prisma,
  createLogger,
  walletRiskScore,
  walletWinScore,
  walletLabels,
  walletScore,
  walletScoreMarket,
  MIN_WIN_SOL,
  OWN_MULTIPLE_MIN_SOL,
  MIN_BUY_SOL_PER_TOKEN,
  OVERSOLD_TOKENS,
  RISKY_WALLET_SCORE,
  WALLET_WIN_MULTIPLE,
  PLATFORM_WALLETS,
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
 *
 * The hidden Wallet Score (user ask 2026-10-16, core's wallets/walletScore.ts) is built from the
 * same rows against the market's rates: coins bought before the anchor that then made a clean 2x
 * or 4x within the hour (the call's outcome row), own trades at 2x or 4x, fast exits and dumps.
 */

/**
 * A clean trade: no more tokens sold than bought on the tape, bought at a price a buy can be
 * (not tokens sent in for a token account's rent), and no sell before the first buy.
 */
const cleanSql = Prisma.sql`(a."tokensSold" <= ${OVERSOLD_TOKENS} * a."tokensBought"
  AND a."solIn" >= ${MIN_BUY_SOL_PER_TOKEN} * a."tokensBought"
  AND NOT (a."firstSellAt" IS NOT NULL AND a."firstBuyAt" IS NOT NULL AND a."firstSellAt" < a."firstBuyAt"))`;

/** A win: the wallet's own clean trade at WALLET_WIN_MULTIPLE or better, for MIN_WIN_SOL of profit. */
const winSql = Prisma.sql`(a."solIn" > 0
  AND a."solOut" >= ${WALLET_WIN_MULTIPLE} * a."solIn"
  AND a."solOut" - a."solIn" >= ${MIN_WIN_SOL}
  AND ${cleanSql})`;

/** An own trade at `multiple` or better (the Wallet Score's own2x / own4x). */
const ownMultipleSql = (multiple: number) => Prisma.sql`(a."solIn" >= ${OWN_MULTIPLE_MIN_SOL}
  AND a."solOut" >= ${multiple} * a."solIn"
  AND ${cleanSql})`;

/** Bought before the tape's anchor, so a decision could have seen it buying. */
/** Platform wallets (the Stonk fee wallet) aren't traders; tape rows stored before the tape
 * skipped them stop counting here. */
const traderSql = Prisma.sql`a."buys" > 0 AND a."wallet" <> ALL(${[...PLATFORM_WALLETS.keys()]})`;
const earlySql = Prisma.sql`(a."firstBuyAt" IS NOT NULL AND a."firstBuyAt" < t."anchorAt")`;

/** The Wallet Score's counts, as one SELECT list (the per-wallet query and the market totals). */
export const scoreCountsSql = Prisma.sql`COUNT(*) FILTER (WHERE ${earlySql}) AS "earlyBuys",
  COUNT(*) FILTER (WHERE ${earlySql} AND o."hit2xIn1h" AND o."disqualified" IS NOT TRUE) AS "early2x",
  COUNT(*) FILTER (WHERE ${earlySql} AND o."hit4xIn1h" AND o."disqualified" IS NOT TRUE) AS "early4x",
  COUNT(*) FILTER (WHERE ${ownMultipleSql(2)}) AS "own2x",
  COUNT(*) FILTER (WHERE ${ownMultipleSql(4)}) AS "own4x",
  COUNT(*) FILTER (WHERE a."fastExit") AS "fastExits"`;

export type ScoreCountRow = Record<
  "earlyBuys" | "early2x" | "early4x" | "own2x" | "own4x" | "fastExits",
  bigint
>;

export const scoreCounts = (r: ScoreCountRow) => ({
  earlyBuys: Number(r.earlyBuys),
  early2x: Number(r.early2x),
  early4x: Number(r.early4x),
  own2x: Number(r.own2x),
  own4x: Number(r.own4x),
  fastExits: Number(r.fastExits),
});

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
    { name: "earlyBuys", type: "integer" },
    { name: "early2x", type: "integer" },
    { name: "early4x", type: "integer" },
    { name: "own2x", type: "integer" },
    { name: "own4x", type: "integer" },
    { name: "walletScore", type: "double precision" },
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
  // The Wallet Score's market rates are over the same rows (bought), from the same SELECT list.
  const [totals] = await prisma.$queryRaw<
    ({ appearances: bigint; dumps: bigint; wins: bigint } & ScoreCountRow)[]
  >`
    SELECT COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           COUNT(*) FILTER (WHERE ${winSql}) AS wins,
           ${scoreCountsSql}
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    LEFT JOIN "CandidateOutcome" o ON o."id" = t."outcomeId"
    WHERE ${traderSql}`;
  const appearances = Number(totals?.appearances ?? 0);
  const marketDumpRate = appearances > 0 ? Number(totals!.dumps) / appearances : 0;
  const marketWinRate = appearances > 0 ? Number(totals!.wins) / appearances : 0;
  const scoreMarket = walletScoreMarket({
    appearances,
    dumps: Number(totals?.dumps ?? 0),
    ...(totals
      ? scoreCounts(totals)
      : { earlyBuys: 0, early2x: 0, early4x: 0, own2x: 0, own4x: 0, fastExits: 0 }),
  });

  const rows = await prisma.$queryRaw<
    (Omit<Agg, "appearances" | "dumps" | "fastExits" | "snipes" | "wins" | "earlyWins"> &
      ScoreCountRow & {
        appearances: bigint;
        dumps: bigint;
        snipes: bigint;
        wins: bigint;
        earlyWins: bigint;
      })[]
  >`
    SELECT a."wallet",
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           ${scoreCountsSql},
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
    LEFT JOIN "CandidateOutcome" o ON o."id" = t."outcomeId"
    WHERE ${traderSql}
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
    const counts = scoreCounts(r);
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
      earlyBuys: counts.earlyBuys,
      early2x: counts.early2x,
      early4x: counts.early4x,
      own2x: counts.own2x,
      own4x: counts.own4x,
      walletScore: walletScore(
        { ...counts, appearances: stats.appearances, dumps: stats.dumps },
        scoreMarket,
      ),
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
    walletScored: data.filter((d) => d.walletScore !== null).length,
    appearances,
  };
  logger.info("wallet risk rebuilt", meta);
  return meta;
}
