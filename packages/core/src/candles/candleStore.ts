import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  CANDLE_CHUNK_BARS,
  CANDLE_RESOLUTIONS,
  FINE_CANDLE_MAX_RES,
  packBars,
  unpackBars,
  type CandleChunkRow,
  type CandleRes,
  type CandleStoreSource,
} from "./candleChunk.js";

/**
 * The closed-candle store in Postgres (CandleChunk, CandleBackfill). Every write is one statement
 * of up to SAVE_BATCH rows, so a writer holds one pooled connection for a moment, never more.
 */

/** Rows per INSERT: 9 parameters each, far under Postgres's limit, and a short statement. */
const SAVE_BATCH = 200;

/**
 * Writes chunk rows. A chunk already stored is replaced only by a reading with at least as many
 * bars: closed candles don't change, so the fuller reading of a chunk is the better one, and a
 * page that reaches only part of a chunk never thins out what an earlier one saved.
 */
export async function saveCandleChunks(rows: readonly CandleChunkRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += SAVE_BATCH) {
    const batch = rows.slice(i, i + SAVE_BATCH).filter((r) => r.bars.length > 0);
    if (batch.length === 0) continue;
    const values = batch.map(
      (r) =>
        Prisma.sql`(${r.mint}, ${r.res}, ${new Date(r.startAt)}, ${r.source}, ${new Date(r.coverFrom)}, ${new Date(r.coverTo)}, ${r.bars.length}, ${r.coarse}, ${packBars(r.bars, r.startAt, r.res)})`,
    );
    written += await prisma.$executeRaw`
      INSERT INTO "CandleChunk" ("mint", "res", "startAt", "source", "coverFrom", "coverTo", "bars", "coarse", "data")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("mint", "res", "startAt", "source") DO UPDATE SET
        "coverFrom" = EXCLUDED."coverFrom",
        "coverTo" = EXCLUDED."coverTo",
        "bars" = EXCLUDED."bars",
        "coarse" = EXCLUDED."coarse",
        "data" = EXCLUDED."data",
        "savedAt" = CURRENT_TIMESTAMP
      WHERE EXCLUDED."bars" >= "CandleChunk"."bars"`;
  }
  return written;
}

/** The widest chunk span (5 m bars), how far before `from` a chunk can start and still reach it. */
const WIDEST_SPAN_MS = 300 * 1_000 * CANDLE_CHUNK_BARS;

/** A coin's stored chunks that reach into [from, to), decoded, oldest first. */
export async function readCandleChunks(mint: string, from: number, to: number): Promise<CandleChunkRow[]> {
  const rows = await prisma.candleChunk.findMany({
    where: {
      mint,
      startAt: { gte: new Date(from - WIDEST_SPAN_MS), lt: new Date(to) },
      coverTo: { gt: new Date(from) },
    },
    orderBy: { startAt: "asc" },
  });
  return rows.map((r) => ({
    mint: r.mint,
    res: r.res as CandleRes,
    startAt: r.startAt.getTime(),
    source: r.source as CandleStoreSource,
    coverFrom: r.coverFrom.getTime(),
    coverTo: r.coverTo.getTime(),
    bars: unpackBars(r.data, r.startAt.getTime(), r.res),
    coarse: r.coarse,
  }));
}

/** The oldest moment any stored chunk of the coin covers (ms), null with none. */
export async function oldestCandleCover(mint: string): Promise<number | null> {
  const row = await prisma.candleChunk.aggregate({ where: { mint }, _min: { coverFrom: true } });
  return row._min.coverFrom?.getTime() ?? null;
}

/**
 * The covers of the coin's minute-or-finer chunks that start before `before` (ms), newest first,
 * `limit` at most: what the backfill walks back over instead of asking for it again.
 */
export async function minuteCoversBefore(
  mint: string,
  before: number,
  limit = 500,
): Promise<{ from: number; to: number }[]> {
  const rows = await prisma.candleChunk.findMany({
    where: { mint, res: { lte: 60 }, startAt: { lt: new Date(before) } },
    orderBy: { startAt: "desc" },
    take: limit,
    select: { coverFrom: true, coverTo: true },
  });
  return rows.map((r) => ({ from: r.coverFrom.getTime(), to: r.coverTo.getTime() }));
}

/** Why a backfill was asked for; a call goes ahead of a chart. */
export type CandleBackfillReason = "chart" | "call";

/** A finished backfill is started again when asked this long after it ended (newer gaps to fill). */
export const BACKFILL_REDO_AFTER_MS = 6 * 3_600_000;
/**
 * The same for a coin Pump.fun has no candles for (another launchpad, a Raydium or Meteora pool):
 * its newest stretch comes only from GeckoTerminal, so a chart opened on it tops the store up from
 * now back to what is saved, a page or two, rather than leaving hours since the last backfill to
 * the live tail, which starts when the chart opened (chart gaps audit 2026-10-23).
 */
export const BACKFILL_TOP_UP_AFTER_MS = 10 * 60_000;

/**
 * Asks for the coin's one-time backfill (one statement). A coin already queued is left as it is,
 * except that a call moves a chart's ask ahead; one finished more than `redoAfterMs` ago
 * (BACKFILL_REDO_AFTER_MS, or BACKFILL_TOP_UP_AFTER_MS for a coin with no Pump.fun candles) is
 * queued again from the start.
 */
export async function requestCandleBackfill(
  mint: string,
  reason: CandleBackfillReason,
  now = Date.now(),
  redoAfterMs = BACKFILL_REDO_AFTER_MS,
): Promise<void> {
  const at = new Date(now);
  const redoBefore = new Date(now - redoAfterMs);
  await prisma.$executeRaw`
    INSERT INTO "CandleBackfill" ("mint", "reason", "requestedAt", "nextAt")
    VALUES (${mint}, ${reason}, ${at}, ${at})
    ON CONFLICT ("mint") DO UPDATE SET
      "reason" = CASE WHEN EXCLUDED."reason" = 'call' THEN 'call' ELSE "CandleBackfill"."reason" END,
      "requestedAt" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."requestedAt" ELSE EXCLUDED."requestedAt" END,
      "nextAt" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."nextAt" ELSE EXCLUDED."nextAt" END,
      "doneAt" = NULL, "pumpDone" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."pumpDone" ELSE false END,
      "poolIndex" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."poolIndex" ELSE 0 END,
      "cursor" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."cursor" ELSE NULL END,
      "pages" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."pages" ELSE 0 END,
      "failures" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."failures" ELSE 0 END,
      "error" = CASE WHEN "CandleBackfill"."doneAt" IS NULL THEN "CandleBackfill"."error" ELSE NULL END
    WHERE ("CandleBackfill"."doneAt" IS NULL
           AND EXCLUDED."reason" = 'call' AND "CandleBackfill"."reason" <> 'call')
       OR "CandleBackfill"."doneAt" < ${redoBefore}`;
}

export interface CandleRetention {
  /** Days 1 s and 15 s chunks are kept (CANDLE_FINE_RETENTION_DAYS). */
  fineDays: number;
  /** Days minute and wider chunks are kept at most (CANDLE_RETENTION_DAYS). */
  keepDays: number;
  /** Rows per DELETE. */
  rowsPerBatch: number;
  /** Pause between DELETEs, so the sweep never holds the table busy for long. */
  pauseMs?: number;
}

/**
 * The nightly sweep of the store: fine chunks past fineDays, wider ones past keepDays, and every
 * chunk of a coin no longer on Token (the cleanup deleted it: its tracked life is over) that is a
 * day old. Finished backfills go with the same horizons. Each width is swept on its own range of
 * the (res, startAt) index, so a batch never walks the rows it keeps; each DELETE is its own short
 * statement. Returns the rows deleted.
 */
export async function pruneCandleStore(
  opts: CandleRetention,
  now = Date.now(),
): Promise<{ chunks: number; backfills: number }> {
  const keepCutoff = new Date(now - opts.keepDays * 86_400_000);
  const orphanCutoff = new Date(now - 86_400_000);
  const pause = () => new Promise((r) => setTimeout(r, opts.pauseMs ?? 0));
  let chunks = 0;
  for (const res of CANDLE_RESOLUTIONS) {
    const days = res <= FINE_CANDLE_MAX_RES ? Math.min(opts.fineDays, opts.keepDays) : opts.keepDays;
    const cutoff = new Date(now - days * 86_400_000);
    for (;;) {
      const n = await prisma.$executeRaw`
        DELETE FROM "CandleChunk" WHERE ctid IN (
          SELECT c.ctid FROM "CandleChunk" c
          WHERE c."res" = ${res} AND c."startAt" < ${cutoff}
          LIMIT ${opts.rowsPerBatch})`;
      chunks += n;
      if (n < opts.rowsPerBatch) break;
      await pause();
    }
  }
  // Coins gone from Token: found in one pass, then deleted by mint on the primary key.
  const orphans = await prisma.$queryRaw<{ mint: string }[]>`
    SELECT DISTINCT c."mint" FROM "CandleChunk" c
    WHERE c."startAt" < ${orphanCutoff}
      AND NOT EXISTS (SELECT 1 FROM "Token" t WHERE t."mintAddress" = c."mint")`;
  for (let i = 0; i < orphans.length; i += ORPHAN_MINTS_PER_DELETE) {
    const mints = orphans.slice(i, i + ORPHAN_MINTS_PER_DELETE).map((r) => r.mint);
    chunks += await prisma.$executeRaw`DELETE FROM "CandleChunk" WHERE "mint" = ANY(${mints})`;
    await pause();
  }
  const backfills = await prisma.$executeRaw`
    DELETE FROM "CandleBackfill" b
    WHERE b."requestedAt" < ${keepCutoff}
       OR (b."requestedAt" < ${orphanCutoff}
           AND NOT EXISTS (SELECT 1 FROM "Token" t WHERE t."mintAddress" = b."mint"))`;
  return { chunks, backfills };
}

/** Coins whose chunks one orphan DELETE takes. */
const ORPHAN_MINTS_PER_DELETE = 50;
