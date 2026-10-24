import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  CANDLE_CHUNK_BARS,
  CANDLE_RESOLUTIONS,
  FINE_CANDLE_MAX_RES,
  mergeChunks,
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
 * Writes chunk rows. A chunk already stored is merged with the new reading (candleChunk.ts
 * mergeChunks): every bar of either, the new reading's winning a slot both hold, and the covers
 * joined where they touch. Closed candles don't change, so the union is the fuller reading. Until
 * 2026-10-23 a reading with fewer bars than the stored one was dropped whole: GeckoTerminal's page
 * on a graduated coin's bonding curve (its first minutes) landed in the same hour as the page on
 * its pool and was thrown away, so a coin's run from $15K to $600K was missing from its chart
 * (user report, 2TKD). The rows of a batch are locked while they are merged, so two writers of
 * the same chunk (the worker's tapes and the API's stream save) never lose each other's bars.
 */
export async function saveCandleChunks(rows: readonly CandleChunkRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += SAVE_BATCH) {
    // A row with no bar stands only for its cover: a quiet stretch a read went through (the chain
    // fill's, candleChainFill.ts); one with neither is nothing.
    const batch = rows.slice(i, i + SAVE_BATCH).filter((r) => r.bars.length > 0 || r.coverTo > r.coverFrom);
    if (batch.length === 0) continue;
    written += await prisma.$transaction(
      async (tx) => {
        // One writer per coin at a time: the row lock below holds only rows that exist, so two
        // writers inserting the same new chunk at once would each see nothing stored and the
        // second's upsert would stand alone, the first's bars gone (audit 2026-10-23 CE-8: the
        // chain fill and the trade tape both write a coin's "tape" chunks). Taken in one order,
        // in one statement: one round trip per batch, not one per coin (the curve tape's flush of
        // ~800 coins spent 20-60 s on them alone, and the store ran up to two minutes behind the
        // live edge; chart audit 2026-10-24).
        const lockKeys = [...new Set(batch.map((r) => r.mint))].sort().map((mint) => "candles:" + mint);
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(k))
          FROM unnest(${lockKeys}::text[]) WITH ORDINALITY AS t(k, n)
          ORDER BY n`;
        const keys = batch.map(
          (r) => Prisma.sql`(${r.mint}, ${r.res}, ${new Date(r.startAt)}::timestamptz, ${r.source})`,
        );
        const held = await tx.$queryRaw<
          {
            mint: string;
            res: number;
            startAt: Date;
            source: string;
            coverFrom: Date;
            coverTo: Date;
            data: Buffer;
          }[]
        >`
          SELECT "mint", "res", "startAt", "source", "coverFrom", "coverTo", "data"
          FROM "CandleChunk"
          WHERE ("mint", "res", "startAt", "source") IN (${Prisma.join(keys)})
          FOR UPDATE`;
        const stored = new Map(
          held.map((h) => [
            chunkKey(h.mint, h.res, h.startAt.getTime(), h.source),
            {
              mint: h.mint,
              res: h.res as CandleRes,
              startAt: h.startAt.getTime(),
              source: h.source as CandleStoreSource,
              coverFrom: h.coverFrom.getTime(),
              coverTo: h.coverTo.getTime(),
              bars: unpackBars(h.data, h.startAt.getTime(), h.res),
              coarse: h.res > 60,
            } satisfies CandleChunkRow,
          ]),
        );
        // The same chunk twice in one batch: the later reading merged onto the earlier.
        const merged = new Map<string, CandleChunkRow>();
        for (const r of batch) {
          const key = chunkKey(r.mint, r.res, r.startAt, r.source);
          const older = merged.get(key) ?? stored.get(key);
          merged.set(key, older ? mergeChunks(older, r) : r);
        }
        const values = [...merged.values()].map(
          (r) =>
            Prisma.sql`(${r.mint}, ${r.res}, ${new Date(r.startAt)}, ${r.source}, ${new Date(r.coverFrom)}, ${new Date(r.coverTo)}, ${r.bars.length}, ${r.coarse}, ${packBars(r.bars, r.startAt, r.res)})`,
        );
        return tx.$executeRaw`
          INSERT INTO "CandleChunk" ("mint", "res", "startAt", "source", "coverFrom", "coverTo", "bars", "coarse", "data")
          VALUES ${Prisma.join(values)}
          ON CONFLICT ("mint", "res", "startAt", "source") DO UPDATE SET
            "coverFrom" = EXCLUDED."coverFrom",
            "coverTo" = EXCLUDED."coverTo",
            "bars" = EXCLUDED."bars",
            "coarse" = EXCLUDED."coarse",
            "data" = EXCLUDED."data",
            "savedAt" = CURRENT_TIMESTAMP`;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  }
  return written;
}

function chunkKey(mint: string, res: number, startAt: number, source: string): string {
  return `${mint}:${res}:${startAt}:${source}`;
}

/** The widest chunk span (5 m bars), how far before `from` a chunk can start and still reach it. */
const WIDEST_SPAN_MS = 300 * 1_000 * CANDLE_CHUNK_BARS;

/**
 * How many chunks starting before the window's reach are looked at for a cover running on into it:
 * the newest minute chunk of each wide source (GeckoTerminal's, Pump.fun's) is the one whose cover
 * runs on over a quiet stretch; the finer sources' covers run on at most a few hours.
 */
const FAR_COVERS = 4;

/**
 * A coin's stored chunks that reach into [from, to), decoded, oldest first. `only`: those of one
 * width and/or source alone, so a reader after one kind doesn't decode every other. A chunk's
 * cover can run on past its own span over a quiet stretch (the tapes' last chunk, a GeckoTerminal
 * page's minutes between trades): chunks starting up to the widest span before `from` are read
 * whole, and past that the newest minute-or-wider chunks whose cover still reaches `from`, so a
 * coin quiet for a day reads as quiet, not as a stretch nobody read (user report 2026-10-23, 9q57:
 * hours drawn as "No data recorded" between its trades).
 */
export async function readCandleChunks(
  mint: string,
  from: number,
  to: number,
  only: { res?: CandleRes; source?: CandleStoreSource } = {},
): Promise<CandleChunkRow[]> {
  const near = new Date(from - WIDEST_SPAN_MS);
  const kind = {
    ...(only.res !== undefined ? { res: only.res } : {}),
    ...(only.source !== undefined ? { source: only.source } : {}),
  };
  const [rows, far] = await Promise.all([
    prisma.candleChunk.findMany({
      where: { mint, startAt: { gte: near, lt: new Date(to) }, coverTo: { gt: new Date(from) }, ...kind },
      orderBy: { startAt: "asc" },
    }),
    only.res !== undefined && only.res < 60
      ? Promise.resolve([])
      : prisma.candleChunk.findMany({
          where: {
            mint,
            res: only.res !== undefined ? only.res : { gte: 60 },
            startAt: { lt: near },
            coverTo: { gt: new Date(from) },
            ...(only.source !== undefined ? { source: only.source } : {}),
          },
          orderBy: { startAt: "desc" },
          take: FAR_COVERS,
        }),
  ]);
  return [...far.reverse(), ...rows].map((r) => ({
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

/** What the store holds of one coin from each source: for the chart diagnostic (/stats/candles/:mint). */
export async function chunkSourceSummary(
  mint: string,
): Promise<
  { source: string; res: number; chunks: number; bars: number; coverFrom: number; coverTo: number }[]
> {
  const rows = await prisma.$queryRaw<
    { source: string; res: number; chunks: bigint; bars: bigint; coverFrom: Date; coverTo: Date }[]
  >`
    SELECT "source", "res", count(*) AS chunks, sum("bars") AS bars,
           min("coverFrom") AS "coverFrom", max("coverTo") AS "coverTo"
    FROM "CandleChunk" WHERE "mint" = ${mint}
    GROUP BY "source", "res" ORDER BY "res", "source"`;
  return rows.map((r) => ({
    source: r.source,
    res: r.res,
    chunks: Number(r.chunks),
    bars: Number(r.bars),
    coverFrom: r.coverFrom.getTime(),
    coverTo: r.coverTo.getTime(),
  }));
}

/**
 * The chunks saved lately, per source and width: how many, of how many coins, and the newest
 * save. Read on each width's own range of the (res, startAt) index, so no table scan.
 */
export async function recentChunksBySource(
  sinceMs: number,
  now = Date.now(),
): Promise<{ source: string; res: number; chunks: number; coins: number; newestSavedAt: number }[]> {
  const since = new Date(now - sinceMs);
  const out: { source: string; res: number; chunks: number; coins: number; newestSavedAt: number }[] = [];
  for (const res of CANDLE_RESOLUTIONS) {
    const rows = await prisma.$queryRaw<{ source: string; chunks: bigint; coins: bigint; newest: Date }[]>`
      SELECT "source", count(*) AS chunks, count(DISTINCT "mint") AS coins, max("savedAt") AS newest
      FROM "CandleChunk" WHERE "res" = ${res} AND "startAt" >= ${since} AND "savedAt" >= ${since}
      GROUP BY "source"`;
    for (const r of rows)
      out.push({
        source: r.source,
        res,
        chunks: Number(r.chunks),
        coins: Number(r.coins),
        newestSavedAt: r.newest.getTime(),
      });
  }
  return out;
}

/** A coin the candle store was asked about (a call or a chart's open), as the curve tape follows it. */
export interface AskedCoin {
  mintAddress: string;
  launchedAt: Date | null;
  firstSeenAt: Date;
  launchpad: string | null;
  /** When it was last asked about (the call, or the chart's open). */
  askedAt: Date;
}

/**
 * The coins a chart opened, a call or a match queued within `sinceMs`, newest ask first, `limit` at most:
 * the worker's curve tape follows them for the chart's 1-second bars whatever their age
 * (curveTape.ts), as it follows alerted coins.
 */
export async function recentlyAskedCoins(
  sinceMs: number,
  now = Date.now(),
  limit = 500,
): Promise<AskedCoin[]> {
  const rows = await prisma.candleBackfill.findMany({
    where: { requestedAt: { gte: new Date(now - sinceMs) } },
    orderBy: { requestedAt: "desc" },
    take: limit,
    select: { mint: true, requestedAt: true },
  });
  if (rows.length === 0) return [];
  const tokens = await prisma.token.findMany({
    where: { mintAddress: { in: rows.map((r) => r.mint) } },
    select: { mintAddress: true, launchedAt: true, firstSeenAt: true, launchpad: true },
  });
  const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
  return rows.flatMap((r) => {
    const t = byMint.get(r.mint);
    return t ? [{ ...t, askedAt: r.requestedAt }] : [];
  });
}

/**
 * Queues the backfill of every coin called, or put on a Live Feed by a filter match, within
 * `sinceMs` that has no row yet (one statement each): the call's and the match's own asks
 * (curatedAlerts.ts, matchDispatch.ts) are fire-and-forget, and a database busy at that moment
 * left the coin with no history on its chart (2TKD, 2026-10-23: called at 19:03, no row until a
 * second call at 19:13). Returns how many were queued.
 */
export async function queueBackfillsForRecentCalls(sinceMs: number, now = Date.now()): Promise<number> {
  const at = new Date(now);
  const since = new Date(now - sinceMs);
  const calls = await prisma.$executeRaw`
    INSERT INTO "CandleBackfill" ("mint", "reason", "requestedAt", "nextAt")
    SELECT DISTINCT ON (t."mintAddress") t."mintAddress", 'call', a."createdAt", ${at}
    FROM "CuratedAlert" a JOIN "Token" t ON t."id" = a."tokenId"
    WHERE a."createdAt" >= ${since}
      AND NOT EXISTS (SELECT 1 FROM "CandleBackfill" b WHERE b."mint" = t."mintAddress")
    ORDER BY t."mintAddress", a."createdAt" DESC
    ON CONFLICT ("mint") DO NOTHING`;
  const matches = await prisma.$executeRaw`
    INSERT INTO "CandleBackfill" ("mint", "reason", "requestedAt", "nextAt")
    SELECT DISTINCT ON (t."mintAddress") t."mintAddress", 'match', m."matchedAt", ${at}
    FROM "Match" m JOIN "Token" t ON t."id" = m."tokenId"
    WHERE m."matchedAt" >= ${since}
      AND NOT EXISTS (SELECT 1 FROM "CandleBackfill" b WHERE b."mint" = t."mintAddress")
    ORDER BY t."mintAddress", m."matchedAt" DESC
    ON CONFLICT ("mint") DO NOTHING`;
  return calls + matches;
}

/**
 * Why a backfill was asked for: a chart opened, a call, or a filter match putting the coin on a
 * Live Feed (user report 2026-10-24: a matched coin's chart was blank until someone opened it). A
 * call goes ahead of the others.
 */
export type CandleBackfillReason = "chart" | "call" | "match";

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
