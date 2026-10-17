import {
  prisma,
  createLogger,
  isPaidBuy,
  isPaidSell,
  Prisma,
  walletLabels,
  winnerFollowReading,
  type ScoredWallet,
  type StoredTrade,
  type WinnerFollowReading,
} from "@trenchscanner/core";
import { ownMultipleSql, transferFedSql, winSql } from "./walletRiskJob.js";

const logger = createLogger("winner-follow-backfill");

/**
 * The clean winners' reading of the newest buyers (user ask 2026-10-17, core's
 * wallets/winnerFollow.ts: the Winners seat's inputs) for the decision rows banked before the scan
 * recorded it, once, rebuilt point-in-time, so the seat has an exam to sit from its first run.
 *
 * The scan reads the buyers in the coin's newest page of trades (the live tape, up to
 * LIVE_PAGE_TRADES trades), which isn't kept. What is kept is the coin's trade tape, which starts a
 * few minutes before its anchor and stores each wallet's trades (TokenWalletActivity.trades, the
 * first and last 100 of a busy wallet): so a row is rebuilt only when its token has a tape anchored
 * within NEAR_TAPE_MS of the row, and its page is the newest LIVE_PAGE_TRADES of those trades
 * before the row's anchor. Unlike the Wallet Score backfill, a row needs no live page of its own
 * at the time: every row this near a tape is a call moment or its taped comparison, the coins the
 * live tape reads.
 *
 * Point-in-time: each buyer's record is built from the tape rows written before the last hourly
 * rebuild the scan could have loaded (the hour the row's anchor falls in), with its Winner label
 * against the market's rates over the same rows and only the holder transfers recorded before then:
 * what the hourly table (walletRiskJob.ts) held. A coin's own tape is written after its anchor, so
 * it is never in its own rows' records.
 *
 * Writes the WINNER_FOLLOW_FEATURES into the row's feature vector (CandidateOutcome.features);
 * the scan writes them from now on, so a row that has recentBuyersRead is skipped. A few hundred rows
 * a run on the history re-grade's schedule; once through, a no-op that never asks the database again
 * in this process.
 */
/**
 * A tape's per-wallet trades are stored from 10-13 06:00 (TokenWalletActivity.trades); the book
 * has a day and a half of tapes behind it by then.
 */
export const WINNER_FOLLOW_BACKFILL_FROM = new Date("2026-10-13T06:00:00Z");
/** Each row reads its coin's whole tape: kept small to stay well inside the job's deadline. */
export const WINNER_FOLLOW_ROWS_PER_RUN = 100;
/** How far a row's anchor can sit from its token's tape anchor and still be read from the tape. */
const NEAR_TAPE_MS = 60_000;
/** A live page's size: one getTransactionsForAddress page (liveTape.ts). */
export const LIVE_PAGE_TRADES = 100;
const HOUR_MS = 3_600_000;

let cursor: { at: Date; id: string } | null = null;
let until: Date | null = null;
let finished = false;
/** The market's totals by the hour the tape rows were written, cumulative, read once per process. */
let marketByHour: { hourMs: number; appearances: number; dumps: number; wins: number }[] | null = null;
const totals = { rows: 0, filled: 0, noBuyers: 0 };

/** Test hook. */
export function resetWinnerFollowBackfill(): void {
  cursor = null;
  until = null;
  finished = false;
  marketByHour = null;
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = 0;
}

async function loadMarket(): Promise<{ hourMs: number; appearances: number; dumps: number; wins: number }[]> {
  const rows = await prisma.$queryRaw<{ hour: Date; appearances: bigint; dumps: bigint; wins: bigint }[]>`
    SELECT date_trunc('hour', a."createdAt") AS hour,
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           COUNT(*) FILTER (WHERE ${winSql}) AS wins
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    WHERE a."buys" > 0
    GROUP BY 1
    ORDER BY 1`;
  let run = { appearances: 0, dumps: 0, wins: 0 };
  return rows.map((r) => {
    run = {
      appearances: run.appearances + Number(r.appearances),
      dumps: run.dumps + Number(r.dumps),
      wins: run.wins + Number(r.wins),
    };
    return { hourMs: r.hour.getTime() + HOUR_MS, ...run };
  });
}

/** The market's rates over the tape rows written before `cutoffMs` (an hour boundary). */
function marketAt(cutoffMs: number): { dumpRate: number; winRate: number } {
  let out = { appearances: 0, dumps: 0, wins: 0 };
  for (const h of marketByHour ?? []) {
    if (h.hourMs > cutoffMs) break;
    out = h;
  }
  return out.appearances > 0
    ? { dumpRate: out.dumps / out.appearances, winRate: out.wins / out.appearances }
    : { dumpRate: 0, winRate: 0 };
}

/**
 * The newest `limit` trades before `anchorMs` from a tape's per-wallet trade lists, newest first,
 * as the live page carries them. Malformed entries are skipped.
 */
export function pageBefore(
  rows: readonly { wallet: string; trades: unknown }[],
  anchorMs: number,
  limit = LIVE_PAGE_TRADES,
): { wallet: string; side: "buy" | "sell"; sol: number; tokens: number; atMs: number }[] {
  const all: { wallet: string; side: "buy" | "sell"; sol: number; tokens: number; atMs: number }[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.trades)) continue;
    for (const t of r.trades as StoredTrade[]) {
      if (!Array.isArray(t) || typeof t[0] !== "number" || t[0] >= anchorMs) continue;
      all.push({
        wallet: r.wallet,
        side: t[1] === 1 ? "buy" : "sell",
        sol: Number(t[2]) || 0,
        tokens: Number(t[3]) || 0,
        atMs: t[0],
      });
    }
  }
  all.sort((a, b) => b.atMs - a.atMs);
  return all.slice(0, limit);
}

/** The reading for one row, or null when no trade before the anchor is on the tape. */
export async function rebuildRow(
  tokenId: string,
  anchorAt: Date,
  tapes: Map<string, Promise<{ wallet: string; trades: unknown }[]>> = new Map(),
): Promise<WinnerFollowReading | null> {
  // The coin's tape, read once a batch: the match, event and hourly rows near one tape share it.
  let read = tapes.get(tokenId);
  if (!read) {
    read = prisma.tokenWalletActivity.findMany({
      where: { tokenId },
      select: { wallet: true, trades: true },
    });
    tapes.set(tokenId, read);
  }
  const tape = await read;
  const page = pageBefore(tape, anchorAt.getTime());
  // The wallets that paid for a buy or were paid for a sell: a transfer is neither (the reading's
  // own rules). No buyer, no reading, as live.
  if (!page.some(isPaidBuy)) return null;
  const traders = [...new Set(page.filter((t) => isPaidBuy(t) || isPaidSell(t)).map((t) => t.wallet))];
  const cutoff = new Date(Math.floor(anchorAt.getTime() / HOUR_MS) * HOUR_MS);
  const records = await prisma.$queryRaw<
    {
      wallet: string;
      appearances: bigint;
      dumps: bigint;
      snipes: bigint;
      wins: bigint;
      own2x: bigint;
      transferWins: bigint;
      solIn: number;
    }[]
  >`
    SELECT a."wallet",
           COUNT(*) AS appearances,
           COUNT(*) FILTER (WHERE a."dumpedIntoStop") AS dumps,
           COUNT(*) FILTER (WHERE a."launchSniper") AS snipes,
           COUNT(*) FILTER (WHERE ${winSql}) AS wins,
           COUNT(*) FILTER (WHERE ${ownMultipleSql(2)}) AS own2x,
           COUNT(*) FILTER (WHERE ${transferFedSql(cutoff)}) AS "transferWins",
           SUM(a."solIn"::numeric)::float8 AS "solIn"
    FROM "TokenWalletActivity" a
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    WHERE a."buys" > 0
      AND a."createdAt" < ${cutoff}
      AND a."wallet" IN (${Prisma.join(traders)})
    GROUP BY a."wallet"`;
  const market = marketAt(cutoff.getTime());
  const book = new Map<string, ScoredWallet>();
  for (const r of records) {
    const appearances = Number(r.appearances);
    // The hourly table keeps wallets seen in two coins or more (walletRiskJob.ts MIN_APPEARANCES).
    if (appearances < 2) continue;
    const labels = walletLabels(
      { appearances, dumps: Number(r.dumps), wins: Number(r.wins), snipes: Number(r.snipes) },
      market,
    );
    book.set(r.wallet, {
      score: 0,
      dumps: Number(r.dumps),
      appearances,
      winner: labels.winner,
      own2x: Number(r.own2x),
      transferWins: Number(r.transferWins),
      solIn: Number(r.solIn),
    });
  }
  return winnerFollowReading(page, (w) => book.get(w));
}

async function setRow(id: string, r: WinnerFollowReading): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "CandidateOutcome"
       SET "features" = "features"
             || jsonb_build_object('cleanWinnerRecentBuyers', ${r.cleanWinnerRecentBuyers}::float8,
                                   'cleanWinnerRecentShare', ${r.cleanWinnerRecentShare}::float8,
                                   'cleanWinnerBuySolShare', ${r.cleanWinnerBuySolShare}::float8,
                                   'recentBuyersOwn2xMean', ${r.recentBuyersOwn2xMean}::float8,
                                   'recentBuyersRead', ${r.recentBuyersRead}::float8,
                                   'cleanWinnerConvictionMax', ${r.cleanWinnerConvictionMax}::float8,
                                   'cleanWinnerNetShare', ${r.cleanWinnerNetShare}::float8,
                                   'cleanWinnerSellerShare', ${r.cleanWinnerSellerShare}::float8)
     WHERE "id" = ${id}`;
}

/** One batch of rows; false once the window is done. */
async function batch(limit: number): Promise<boolean> {
  const after = cursor ?? { at: new Date(0), id: "" };
  const rows = await prisma.$queryRaw<{ id: string; tokenId: string; anchorAt: Date }[]>`
    SELECT o."id", o."tokenId", o."anchorAt"
      FROM "CandidateOutcome" o
      JOIN "TokenTradeTape" t ON t."tokenId" = o."tokenId" AND t."status" IN ('done', 'partial')
     WHERE o."anchorAt" >= ${WINNER_FOLLOW_BACKFILL_FROM} AND o."anchorAt" < ${until!}
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
  const tapes = new Map<string, Promise<{ wallet: string; trades: unknown }[]>>();
  for (const r of rows) {
    const f = featuresOf.get(r.id) ?? {};
    // Already written, by the scan or an earlier run.
    if ("recentBuyersRead" in f) continue;
    totals.rows++;
    const rebuilt = await rebuildRow(r.tokenId, r.anchorAt, tapes);
    if (!rebuilt) {
      totals.noBuyers++;
      continue;
    }
    await setRow(r.id, rebuilt);
    totals.filled++;
  }
  return true;
}

export async function runWinnerFollowBackfill(
  deps: { now?: () => number; rowsPerRun?: number } = {},
): Promise<Record<string, number> | null> {
  if (finished) return null;
  // Rows banked from now on carry the reading from the scan itself.
  until ??= new Date((deps.now ?? Date.now)());
  marketByHour ??= await loadMarket();
  if (!(await batch(deps.rowsPerRun ?? WINNER_FOLLOW_ROWS_PER_RUN))) {
    finished = true;
    logger.info("winner-follow backfill finished", totals);
    return null;
  }
  return { ...totals };
}
