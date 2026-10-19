import {
  prisma,
  Prisma,
  createLogger,
  walletRiskScore,
  walletWinScore,
  walletLabels,
  walletScore,
  walletScoreMarket,
  WALLET_SCORE_MARKET_FIGURES,
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
export const winSql = Prisma.sql`(a."solIn" > 0
  AND a."solOut" >= ${WALLET_WIN_MULTIPLE} * a."solIn"
  AND a."solOut" - a."solIn" >= ${MIN_WIN_SOL}
  AND ${cleanSql})`;

/**
 * A win-sized trade fed by tokens transferred in (user ask 2026-10-17, "excluding ones that win based
 * on tokens being transferred in"): SOL out at WALLET_WIN_MULTIPLE or better for MIN_WIN_SOL of
 * profit, where the tokens it sold weren't all bought on the tape - it sold more than it bought or
 * sold before its first buy (not cleanSql), or a holder transfer of the coin reached it
 * (HolderTransferEvent, the scan's linking transfers between top holders, kept 30 days). The
 * Winners seat reads a Winner wallet only with none of these (core's wallets/winnerFollow.ts). A
 * partial tape that missed an earlier buy reads the same way: the record can't show it bought them.
 * `before` counts only the transfers the scan had recorded before then (the point-in-time backfill).
 */
export const transferFedSql = (before?: Date) => Prisma.sql`(a."solIn" > 0
  AND a."solOut" >= ${WALLET_WIN_MULTIPLE} * a."solIn"
  AND a."solOut" - a."solIn" >= ${MIN_WIN_SOL}
  AND (NOT ${cleanSql}
       OR EXISTS (SELECT 1 FROM "HolderTransferEvent" h JOIN "Token" tk ON tk."mintAddress" = h."mintAddress"
                   WHERE h."toWallet" = a."wallet" AND tk."id" = a."tokenId"
                     ${before ? Prisma.sql`AND h."createdAt" < ${before}` : Prisma.empty})))`;

/** An own trade at `multiple` or better (the Wallet Score's own2x / own4x). */
export const ownMultipleSql = (multiple: number) => Prisma.sql`(a."solIn" >= ${OWN_MULTIPLE_MIN_SOL}
  AND a."solOut" >= ${multiple} * a."solIn"
  AND ${cleanSql})`;

/** Bought before the tape's anchor, so a decision could have seen it buying. */
/** Platform wallets (the Stonk fee wallet) aren't traders; tape rows stored before the tape
 * skipped them stop counting here. */
/**
 * A coin its profit or loss is read on (the wallet modal's median and average, user ask
 * 2026-10-18): a clean trade that put SOL in and took some out. One it still holds unsold would
 * read as -100% before it sold, and tokens sent in from elsewhere as a profit it never paid for.
 */
const pnlSql = Prisma.sql`(a."solIn" > 0 AND a."solOut" > 0 AND ${cleanSql})`;

const traderSql = Prisma.sql`a."buys" > 0 AND a."wallet" <> ALL(${[...PLATFORM_WALLETS.keys()]})`;
const earlySql = Prisma.sql`(a."firstBuyAt" IS NOT NULL AND a."firstBuyAt" < t."anchorAt")`;

/**
 * The read tapes with their coins' outcomes, as `t`, joined to the activity rows `a`. Each tape
 * looks its outcome up by primary key (the LIMIT keeps the lateral from being flattened into a
 * join) and the subquery is kept whole (OFFSET 0): as a plain join the planner hashed the whole
 * CandidateOutcome table, features and all, in both of wallet-risk's whole-tape reads every hour
 * - the read the Wallet Score added on 10-16, after which the job went from 13 s to 75 s
 * (performance audit 2026-10-17).
 */
export const tapeOutcomesJoinSql = Prisma.sql`JOIN (
    SELECT t."tokenId", t."anchorAt", o."hit2xIn1h", o."hit4xIn1h", o."disqualified"
    FROM "TokenTradeTape" t
    LEFT JOIN LATERAL (
      SELECT c."hit2xIn1h", c."hit4xIn1h", c."disqualified"
      FROM "CandidateOutcome" c
      WHERE c."id" = t."outcomeId"
      LIMIT 1
    ) o ON true
    WHERE t."status" IN ('done', 'partial')
    OFFSET 0
  ) t ON t."tokenId" = a."tokenId"`;

/** The Wallet Score's counts, as one SELECT list (the per-wallet query and the market totals). */
export const scoreCountsSql = Prisma.sql`COUNT(*) FILTER (WHERE ${earlySql}) AS "earlyBuys",
  COUNT(*) FILTER (WHERE ${earlySql} AND t."hit2xIn1h" AND t."disqualified" IS NOT TRUE) AS "early2x",
  COUNT(*) FILTER (WHERE ${earlySql} AND t."hit4xIn1h" AND t."disqualified" IS NOT TRUE) AS "early4x",
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
    { name: "transferWins", type: "integer" },
    { name: "medianSupplyPct", type: "double precision" },
    { name: "pnlCoins", type: "integer" },
    { name: "medianPnlSol", type: "double precision" },
    { name: "avgPnlSol", type: "double precision" },
    { name: "medianPnlPct", type: "double precision" },
    { name: "avgPnlPct", type: "double precision" },
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
  transferWins: number;
  pnlCoins: number;
  medianSupplyPct: number | null;
  medianPnlSol: number | null;
  avgPnlSol: number | null;
  medianPnlPct: number | null;
  avgPnlPct: number | null;
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
    ${tapeOutcomesJoinSql}
    WHERE ${traderSql}`;
  const appearances = Number(totals?.appearances ?? 0);
  // Kept to the Wallet Score's significant figures (user decision 2026-10-19, performance audit):
  // unrounded, every tape read nudged them, and the risk and win scores built on them, so the
  // hourly rebuild rewrote ~60 k of ~136 k rows that hadn't really changed.
  const marketRate = (k: number) =>
    appearances > 0 ? Number((k / appearances).toPrecision(WALLET_SCORE_MARKET_FIGURES)) : 0;
  const marketDumpRate = marketRate(Number(totals?.dumps ?? 0));
  const marketWinRate = marketRate(Number(totals?.wins ?? 0));
  const scoreMarket = walletScoreMarket({
    appearances,
    dumps: Number(totals?.dumps ?? 0),
    ...(totals
      ? scoreCounts(totals)
      : { earlyBuys: 0, early2x: 0, early4x: 0, own2x: 0, own4x: 0, fastExits: 0 }),
  });

  const rows = await prisma.$queryRaw<
    (Omit<
      Agg,
      "appearances" | "dumps" | "fastExits" | "snipes" | "wins" | "earlyWins" | "transferWins" | "pnlCoins"
    > &
      ScoreCountRow & {
        appearances: bigint;
        dumps: bigint;
        snipes: bigint;
        wins: bigint;
        earlyWins: bigint;
        transferWins: bigint;
        pnlCoins: bigint;
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
           COUNT(*) FILTER (WHERE ${transferFedSql()}) AS "transferWins",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a."boughtPct") AS "medianSupplyPct",
           COUNT(*) FILTER (WHERE ${pnlSql}) AS "pnlCoins",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a."solOut" - a."solIn")
             FILTER (WHERE ${pnlSql}) AS "medianPnlSol",
           AVG((a."solOut" - a."solIn")::numeric) FILTER (WHERE ${pnlSql})::float8 AS "avgPnlSol",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (a."solOut" / a."solIn" - 1) * 100)
             FILTER (WHERE ${pnlSql}) AS "medianPnlPct",
           AVG(((a."solOut" / a."solIn" - 1) * 100)::numeric) FILTER (WHERE ${pnlSql})::float8 AS "avgPnlPct",
           -- Summed as numeric: float8 addition depends on the order the rows arrive in, so a
           -- plan change (an index walk one hour, a scan the next) moved the last bits of 13-25%
           -- of wallets' sums and replaceRows rewrote those rows for nothing.
           SUM(a."solIn"::numeric)::float8 AS "solIn",
           SUM(a."solOut"::numeric)::float8 AS "solOut",
           MAX(COALESCE(a."firstBuyAt", a."createdAt")) AS "lastSeenAt"
    FROM "TokenWalletActivity" a
    ${tapeOutcomesJoinSql}
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
      transferWins: Number(r.transferWins),
      medianSupplyPct: r.medianSupplyPct === null ? null : Number(r.medianSupplyPct),
      pnlCoins: Number(r.pnlCoins),
      medianPnlSol: r.medianPnlSol === null ? null : Number(r.medianPnlSol),
      avgPnlSol: r.avgPnlSol === null ? null : Number(r.avgPnlSol),
      medianPnlPct: r.medianPnlPct === null ? null : Number(r.medianPnlPct),
      avgPnlPct: r.avgPnlPct === null ? null : Number(r.avgPnlPct),
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
    cleanWinners: data.filter((d) => d.winner && d.transferWins === 0).length,
    snipers: data.filter((d) => d.sniper).length,
    marketDumpRate: Math.round(marketDumpRate * 10_000) / 10_000,
    marketWinRate: Math.round(marketWinRate * 10_000) / 10_000,
    walletScored: data.filter((d) => d.walletScore !== null).length,
    appearances,
  };
  logger.info("wallet risk rebuilt", meta);
  return meta;
}
