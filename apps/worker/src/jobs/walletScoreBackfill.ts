import {
  prisma,
  createLogger,
  Prisma,
  walletScore,
  walletScoreMarket,
  type WalletScoreCounts,
} from "@trenchscanner/core";
import { scoreCounts, scoreCountsSql, type ScoreCountRow } from "./walletRiskJob.js";

const logger = createLogger("wallet-score-backfill");

/**
 * The hidden Wallet Score of the newest buyers (user ask 2026-10-16, core's wallets/walletScore.ts)
 * for the decision rows banked before the scan recorded it, once, rebuilt point-in-time.
 *
 * The scan reads the buyers in the coin's newest page of trades (the live tape), which isn't kept.
 * What is kept is the coin's trade tape, which starts a few minutes before its anchor: so a row is
 * rebuilt only when its token has a tape (a called coin, or an uncalled one taped for comparison)
 * anchored within NEAR_TAPE_MS of the row, and only when the row carried a live page at the time
 * (flaggedBuyers is recorded), so a rebuilt row is one the scan would have filled. Its buyers are
 * the tape's wallets whose first buy fell in the BUYER_WINDOW_MS before the row's anchor.
 *
 * Point-in-time: each buyer's score is built from the tape rows written before the last hourly
 * rebuild the scan could have loaded (the hour the row's anchor falls in), against the market's
 * rates over the same rows: what the hourly table (walletRiskJob.ts) held then. A coin's own tape
 * is written after its anchor, so it is never in its own rows' scores.
 *
 * Writes walletScoreRecentBuyersMean and walletScoreRecentBuyersScored into the row's feature
 * vector (CandidateOutcome.features); the scan writes both from now on, so a row that has the key
 * is skipped. A few hundred rows a run on the history re-grade's schedule; once through, a no-op
 * that never asks the database again in this process.
 */
export const WALLET_SCORE_BACKFILL_FROM = new Date("2026-10-12T00:00:00Z");
export const WALLET_SCORE_ROWS_PER_RUN = 300;
/** How far a row's anchor can sit from its token's tape anchor and still be read from the tape. */
const NEAR_TAPE_MS = 60_000;
/** The buyers a live page would carry: first buys in the minutes before the anchor. */
const BUYER_WINDOW_MS = 3 * 60_000;
const HOUR_MS = 3_600_000;

let cursor: { at: Date; id: string } | null = null;
let until: Date | null = null;
let finished = false;
/** The market's totals by the hour the tape rows were written, cumulative, read once per process. */
let marketByHour: { hourMs: number; total: WalletScoreCounts }[] | null = null;
const totals = { rows: 0, filled: 0, noBuyers: 0 };

/** Test hook. */
export function resetWalletScoreBackfill(): void {
  cursor = null;
  until = null;
  finished = false;
  marketByHour = null;
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = 0;
}

const ZERO: WalletScoreCounts = {
  appearances: 0,
  earlyBuys: 0,
  early2x: 0,
  early4x: 0,
  own2x: 0,
  own4x: 0,
  fastExits: 0,
  dumps: 0,
};

type CountRow = ScoreCountRow & { appearances: bigint; dumps: bigint };

const countsOf = (r: CountRow): WalletScoreCounts => ({
  ...scoreCounts(r),
  appearances: Number(r.appearances),
  dumps: Number(r.dumps),
});

const add = (a: WalletScoreCounts, b: WalletScoreCounts): WalletScoreCounts => ({
  appearances: a.appearances + b.appearances,
  earlyBuys: a.earlyBuys + b.earlyBuys,
  early2x: a.early2x + b.early2x,
  early4x: a.early4x + b.early4x,
  own2x: a.own2x + b.own2x,
  own4x: a.own4x + b.own4x,
  fastExits: a.fastExits + b.fastExits,
  dumps: a.dumps + b.dumps,
});

async function loadMarket(): Promise<{ hourMs: number; total: WalletScoreCounts }[]> {
  const rows = await prisma.$queryRaw<(CountRow & { hour: Date })[]>`
    SELECT date_trunc('hour', a."createdAt") AS hour,
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           ${scoreCountsSql}
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    LEFT JOIN "CandidateOutcome" o ON o."id" = t."outcomeId"
    WHERE a."buys" > 0
    GROUP BY 1
    ORDER BY 1`;
  let run = ZERO;
  return rows.map((r) => {
    run = add(run, countsOf(r));
    return { hourMs: r.hour.getTime() + HOUR_MS, total: run };
  });
}

/** The market's totals over the tape rows written before `cutoffMs` (an hour boundary). */
function marketAt(cutoffMs: number): WalletScoreCounts {
  let out = ZERO;
  for (const h of marketByHour ?? []) {
    if (h.hourMs > cutoffMs) break;
    out = h.total;
  }
  return out;
}

/** The two inputs for one row, or null when no buyer was in the window. */
export async function rebuildRow(
  tokenId: string,
  anchorAt: Date,
): Promise<{ mean: number | null; scored: number } | null> {
  const buyers = await prisma.tokenWalletActivity.findMany({
    where: {
      tokenId,
      buys: { gt: 0 },
      firstBuyAt: { gte: new Date(anchorAt.getTime() - BUYER_WINDOW_MS), lt: anchorAt },
    },
    select: { wallet: true },
  });
  if (buyers.length === 0) return null;
  const cutoff = new Date(Math.floor(anchorAt.getTime() / HOUR_MS) * HOUR_MS);
  const rows = await prisma.$queryRaw<(CountRow & { wallet: string })[]>`
    SELECT a."wallet",
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           ${scoreCountsSql}
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    LEFT JOIN "CandidateOutcome" o ON o."id" = t."outcomeId"
    WHERE a."buys" > 0
      AND a."createdAt" < ${cutoff}
      AND a."wallet" IN (${Prisma.join(buyers.map((b) => b.wallet))})
    GROUP BY a."wallet"`;
  const market = walletScoreMarket(marketAt(cutoff.getTime()));
  let sum = 0;
  let scored = 0;
  for (const r of rows) {
    const s = walletScore(countsOf(r), market);
    if (s === null) continue;
    sum += s;
    scored += 1;
  }
  return { mean: scored > 0 ? Math.round((sum / scored) * 1000) / 1000 : null, scored };
}

async function setRow(id: string, mean: number | null, scored: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "CandidateOutcome"
       SET "features" = "features"
             || jsonb_build_object('walletScoreRecentBuyersMean', ${mean}::float8,
                                   'walletScoreRecentBuyersScored', ${scored}::float8)
     WHERE "id" = ${id}`;
}

/** One batch of rows; false once the window is done. */
async function batch(limit: number): Promise<boolean> {
  const after = cursor ?? { at: new Date(0), id: "" };
  const rows = await prisma.$queryRaw<{ id: string; tokenId: string; anchorAt: Date }[]>`
    SELECT o."id", o."tokenId", o."anchorAt"
      FROM "CandidateOutcome" o
      JOIN "TokenTradeTape" t ON t."tokenId" = o."tokenId" AND t."status" IN ('done', 'partial')
     WHERE o."anchorAt" >= ${WALLET_SCORE_BACKFILL_FROM} AND o."anchorAt" < ${until!}
       AND o."anchorAt" BETWEEN t."anchorAt" - ${NEAR_TAPE_MS} * interval '1 millisecond'
                            AND t."anchorAt" + ${NEAR_TAPE_MS} * interval '1 millisecond'
       AND (o."anchorAt", o."id") > (${after.at}, ${after.id})
     ORDER BY o."anchorAt", o."id"
     LIMIT ${limit}`;
  if (rows.length === 0) return false;
  const last = rows[rows.length - 1]!;
  cursor = { at: last.anchorAt, id: last.id };
  const features = await prisma.candidateOutcome.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true, features: true },
  });
  const featuresOf = new Map(features.map((f) => [f.id, (f.features ?? {}) as Record<string, unknown>]));
  for (const r of rows) {
    const f = featuresOf.get(r.id) ?? {};
    // Already written (by the scan, or an earlier run), or no live page at the time.
    if ("walletScoreRecentBuyersScored" in f || f.flaggedBuyers == null) continue;
    totals.rows++;
    const rebuilt = await rebuildRow(r.tokenId, r.anchorAt);
    if (!rebuilt) {
      totals.noBuyers++;
      continue;
    }
    await setRow(r.id, rebuilt.mean, rebuilt.scored);
    totals.filled++;
  }
  return true;
}

export async function runWalletScoreBackfill(
  deps: { now?: () => number; rowsPerRun?: number } = {},
): Promise<Record<string, number> | null> {
  if (finished) return null;
  // Rows banked from now on carry the reading from the scan itself.
  until ??= new Date((deps.now ?? Date.now)());
  marketByHour ??= await loadMarket();
  if (!(await batch(deps.rowsPerRun ?? WALLET_SCORE_ROWS_PER_RUN))) {
    finished = true;
    logger.info("Wallet Score backfill finished", totals);
    return null;
  }
  return { ...totals };
}
