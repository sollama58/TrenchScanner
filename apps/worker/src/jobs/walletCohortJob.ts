import {
  buildCohorts,
  COHORT_BOT_MIN_COINS,
  COHORT_EARLY_SEC,
  COHORT_MAX_COIN_SHARE,
  COHORT_MIN_COINS,
  COHORT_MIN_PAIR_COINS,
  COHORT_PAIR_GAP_SEC,
  createLogger,
  prisma,
  type CohortPairInput,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";
import { withLongReads } from "./longReads.js";
import { replaceRows, type ReplaceRowsSpec } from "./replaceRows.js";

const logger = createLogger("wallet-cohorts");

/**
 * The recurring wallet cohorts (core's wallets/cohorts.ts says what one is), rebuilt hourly into
 * WalletCohort and WalletCohortPair from the trade tape already stored: no outside call. Read by
 * the scanner's cohortBook.ts for the recorded-only cohort inputs.
 *
 * Only the launch's first COHORT_EARLY_SEC of each read tape count, over the last COHORT_WINDOW_DAYS
 * (the tape rows' own retention, TWA_RETENTION_DAYS, bounds it anyway): a complete tape has them,
 * and a partial one has them since the launch side was kept with it (tradeTapeJob.ts, 2026-11-01).
 * The seeds are picked first, so the self-join over a coin's early buyers runs over the wallets
 * that could form a cohort and not over the crowd (the 2026-10-15 feasibility note's batching was
 * for the same reason, in Python).
 */
export const COHORT_WINDOW_DAYS = 60;

const WALLET_COHORT_TABLE: ReplaceRowsSpec = {
  table: "WalletCohort",
  key: "wallet",
  columns: [
    { name: "wallet", type: "text" },
    { name: "cohortId", type: "text" },
    { name: "size", type: "integer" },
    { name: "coins", type: "integer" },
    { name: "creatorCoins", type: "integer" },
    { name: "lastSeenAt", type: "timestamp(3)" },
    { name: "computedAt", type: "timestamp(3)" },
  ],
  stampColumns: ["computedAt"],
};

const WALLET_COHORT_PAIR_TABLE: ReplaceRowsSpec = {
  table: "WalletCohortPair",
  key: "id",
  columns: [
    { name: "id", type: "text" },
    { name: "a", type: "text" },
    { name: "b", type: "text" },
    { name: "coins", type: "integer" },
    { name: "lastAt", type: "timestamp(3)" },
    { name: "computedAt", type: "timestamp(3)" },
  ],
  stampColumns: ["computedAt"],
};

export async function runWalletCohortJob(opts: { now?: () => number } = {}): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  const since = new Date(now.getTime() - COHORT_WINDOW_DAYS * 24 * 3_600_000);
  const readStarted = Date.now();
  // The seeds' pairs, each with the coins both first-bought within the gap, and each seed's own
  // early coin count. One statement: the early rows are read once into a materialized CTE.
  const { pairs, seeds, creators, coins } = await withLongReads(async (tx) => {
    // Shaped by the 2026-11-01 failure: the first version ran every hour into the 600 s bound and
    // never wrote a row. It looked up each pair's two coin counts with a subquery over the seed CTE
    // (no index, so a full scan per pair: pairs x seeds, ~50 G row reads at production's size) and
    // band-joined every early row on the coin alone. Now the seeds' early rows are kept apart (se),
    // paired by a hash join on the coin and the COHORT_PAIR_GAP_SEC-wide time bucket (two buys
    // within the gap are in the same or a neighbouring bucket), and the counts come from a join.
    // (tokenId, wallet) is unique in TokenWalletActivity, so each early row is one wallet's one coin
    // and each pair row one coin: COUNT(*) is the distinct count.
    const rows = await tx.$queryRaw<
      { a: string; b: string; tokens: string[]; lastAt: Date; coinsA: bigint; coinsB: bigint }[]
    >`
    WITH early AS MATERIALIZED (
      SELECT a."tokenId", a."wallet", a."firstBuyAt"
      FROM "TokenWalletActivity" a
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId"
       AND t."status" IN ('done', 'partial') AND t."launchAt" IS NOT NULL
      WHERE a."buys" > 0 AND a."firstBuyAt" IS NOT NULL
        AND a."firstBuyAt" >= ${since}
        AND a."firstBuyAt" >= t."launchAt"
        AND a."firstBuyAt" < t."launchAt" + make_interval(secs => ${COHORT_EARLY_SEC})
    ), seed AS MATERIALIZED (
      SELECT e."wallet", COUNT(*) AS coins
      FROM early e
      GROUP BY e."wallet"
      HAVING COUNT(*) >= ${COHORT_MIN_COINS}
         AND COUNT(*) < GREATEST(${COHORT_BOT_MIN_COINS}, ${COHORT_MAX_COIN_SHARE} * (SELECT COUNT(DISTINCT "tokenId") FROM early))
    ), se AS MATERIALIZED (
      SELECT e."tokenId", e."wallet", e."firstBuyAt",
             floor(extract(epoch FROM e."firstBuyAt") / ${COHORT_PAIR_GAP_SEC})::bigint AS bucket
      FROM early e
      JOIN seed s ON s."wallet" = e."wallet"
    ), pair AS (
      SELECT x."wallet" AS a, y."wallet" AS b, x."tokenId", GREATEST(x."firstBuyAt", y."firstBuyAt") AS at
      FROM se x
      CROSS JOIN (VALUES (-1), (0), (1)) d(off)
      JOIN se y ON y."tokenId" = x."tokenId" AND y.bucket = x.bucket + d.off
      WHERE y."wallet" > x."wallet"
        AND y."firstBuyAt" BETWEEN x."firstBuyAt" - make_interval(secs => ${COHORT_PAIR_GAP_SEC})
                               AND x."firstBuyAt" + make_interval(secs => ${COHORT_PAIR_GAP_SEC})
    ), kept AS (
      SELECT p.a, p.b, array_agg(p."tokenId") AS tokens, MAX(p.at) AS "lastAt"
      FROM pair p
      GROUP BY p.a, p.b
      HAVING COUNT(*) >= ${COHORT_MIN_PAIR_COINS}
    )
    SELECT k.a, k.b, k.tokens, k."lastAt", sa.coins AS "coinsA", sb.coins AS "coinsB"
    FROM kept k
    JOIN seed sa ON sa."wallet" = k.a
    JOIN seed sb ON sb."wallet" = k.b`;
    const seeds = new Map<string, number>();
    const coins = new Set<string>();
    for (const r of rows) {
      seeds.set(r.a, Number(r.coinsA));
      seeds.set(r.b, Number(r.coinsB));
      for (const t of r.tokens) coins.add(t);
    }
    // The creators of the pairs' coins, from the tape (the launch source's creator, never overwritten).
    const creators =
      coins.size > 0
        ? await tx.$queryRaw<{ tokenId: string; creator: string }[]>`
          SELECT t."tokenId", t."creator"
          FROM "TokenTradeTape" t
          WHERE t."tokenId" = ANY(${[...coins]}) AND t."creator" IS NOT NULL`
        : [];
    return { pairs: rows, seeds, creators, coins };
  });
  const readMs = Date.now() - readStarted;

  const input: CohortPairInput[] = pairs.map((r) => ({ a: r.a, b: r.b, tokens: r.tokens, lastAt: r.lastAt }));
  const creatorOf = new Map(creators.map((c) => [c.tokenId, c.creator]));
  const built = buildCohorts(input, seeds, creatorOf);
  const rows = built.rows.map((r) => ({ ...r, computedAt: now }));
  const pairRows = built.pairs.map((p) => ({ id: `${p.a}:${p.b}`, ...p, computedAt: now }));

  const { written, deleted, pairsWritten } = await prisma.$transaction(
    async (tx) => {
      const w = await replaceRows(tx, WALLET_COHORT_TABLE, rows);
      const p = await replaceRows(tx, WALLET_COHORT_PAIR_TABLE, pairRows);
      return { written: w.written, deleted: w.deleted, pairsWritten: p.written };
    },
    { maxWait: 30_000, timeout: 120_000 },
  );

  const cohorts = new Set(rows.map((r) => r.cohortId));
  const meta: JobRunMeta = {
    wallets: rows.length,
    cohorts: cohorts.size,
    creatorLinked: new Set(rows.filter((r) => r.creatorCoins > 0).map((r) => r.cohortId)).size,
    largest: rows.reduce((m, r) => Math.max(m, r.size), 0),
    candidatePairs: pairs.length,
    keptPairs: pairRows.length,
    coins: coins.size,
    written,
    removed: deleted,
    pairsWritten,
    readMs,
  };
  logger.info("wallet cohorts rebuilt", meta);
  return meta;
}
