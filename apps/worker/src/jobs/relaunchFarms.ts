import type { Prisma } from "@prisma/client";
import {
  createLogger,
  prisma,
  RELAUNCH_FARM_MIN_SIBLINGS,
  RELAUNCH_FARM_WINDOW_MINUTES,
} from "@trenchscanner/core";

const logger = createLogger("relaunch-farms");

export interface RelaunchSiblings {
  /** Other mints with the ticker first seen in the RELAUNCH_FARM_WINDOW_MINUTES before this one. */
  siblings: number;
  /**
   * The highest market cap any of them has been seen at: a snapshot, the newest DexScreener or
   * live reading, or the rejected-coin peak. Read only where the count reaches the block (0 below).
   */
  peakMcapUsd: number;
}

/**
 * How often a farm's peak is read again, and how long a mint not in the table or without a ticker
 * stays unasked about. The siblings are fixed by the mint's first sighting, so a mint below the
 * cut is read once per process; a farm's peak moves, so it is read again at this pace.
 */
export const RELAUNCH_PEAK_REREAD_MS = 5 * 60_000;
/**
 * The read's own statement timeout. It ran inline in the scan cycle under the pool's 150-s
 * statement_timeout alone, and one such read took 102 s in production (2026-10-16 02:31 UTC,
 * database audit D1), the cycle waiting on it the whole time; past this bound the cycle goes on
 * without the block, as it does on any failed read.
 */
export const RELAUNCH_READ_TIMEOUT_MS = 20_000;
/** Mints remembered at once; past this the least recently asked about go. */
const MAX_REMEMBERED = 20_000;

/** What this process read for each mint, or null for one the table had no ticker for, and when. */
const remembered = new Map<string, { reading: RelaunchSiblings | null; readAt: number }>();

function remember(mint: string, reading: RelaunchSiblings | null, now: number): void {
  // Re-inserted so Map order stays "least recently asked about first" for the eviction below.
  remembered.delete(mint);
  if (remembered.size >= MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(mint, { reading, readAt: now });
}

/** Tests: forget every mint. */
export function resetRelaunchSiblingsForTests(): void {
  remembered.clear();
}

/**
 * The same-ticker launches before each mint, for the block on model calls on relaunch farms (see
 * core's curation/relaunchFarm.ts). One query over the Token table the discovery stream already
 * fills, asked once per mint per process: the siblings are fixed by the mint's first sighting,
 * and only a farm's peak (a mint at or past the cut) is read again, every RELAUNCH_PEAK_REREAD_MS.
 * The scan asks about 150-220 candidates a cycle and sees 10-20 new ones, so the read shrinks to
 * those. A mint with no ticker, or not in the table, is left out (the block does not apply) and
 * asked about again after the same pause, since a ticker can arrive with later metadata. On a
 * failed or timed-out read the mints it was about are left out, the same as unread; the ones
 * already read keep their answer.
 */
export async function resolveRelaunchSiblings(
  mints: string[],
  now: number = Date.now(),
): Promise<Map<string, RelaunchSiblings>> {
  const out = new Map<string, RelaunchSiblings>();
  const toRead: string[] = [];
  for (const mint of new Set(mints)) {
    const known = remembered.get(mint);
    const stale =
      known !== undefined &&
      (known.reading === null || known.reading.siblings >= RELAUNCH_FARM_MIN_SIBLINGS) &&
      now - known.readAt >= RELAUNCH_PEAK_REREAD_MS;
    if (known === undefined || stale) toRead.push(mint);
    else if (known.reading !== null) out.set(mint, known.reading);
  }
  if (toRead.length === 0) return out;
  try {
    const rows = await prisma.$transaction(
      async (tx) => {
        // The bound rides the transaction's connection, this statement alone.
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(RELAUNCH_READ_TIMEOUT_MS)}, true)`;
        return readSiblings(tx, toRead);
      },
      { maxWait: 5_000, timeout: RELAUNCH_READ_TIMEOUT_MS + 5_000 },
    );
    const read = new Set<string>();
    for (const r of rows) {
      const reading = { siblings: r.siblings, peakMcapUsd: Number(r.peak ?? 0) };
      remember(r.mintAddress, reading, now);
      out.set(r.mintAddress, reading);
      read.add(r.mintAddress);
    }
    for (const mint of toRead) if (!read.has(mint)) remember(mint, null, now);
  } catch (err) {
    logger.warn("relaunch sibling read failed; the relaunch-farm block is skipped this cycle", {
      mints: toRead.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

async function readSiblings(
  tx: Prisma.TransactionClient,
  mints: string[],
): Promise<{ mintAddress: string; siblings: number; peak: number | null }[]> {
  return tx.$queryRaw<{ mintAddress: string; siblings: number; peak: number | null }[]>`
      WITH sib AS (
        SELECT t."mintAddress", s."id", s."lastMcapUsd", s."liveMarketCapUsd", s."rejectPeak60mMcapUsd"
        FROM "Token" t
        -- Per mint, its window on the firstSeenAt index. As a plain join the planner hashed the
        -- ticker match instead and read the whole Token table every scan cycle (~370 MB, the
        -- shared database's cache pushed out with it); OFFSET 0 keeps it from flattening this.
        LEFT JOIN LATERAL (
          SELECT s."id", s."lastMcapUsd", s."liveMarketCapUsd", s."rejectPeak60mMcapUsd"
          FROM "Token" s
          WHERE s."firstSeenAt" >= t."firstSeenAt" - make_interval(mins => ${RELAUNCH_FARM_WINDOW_MINUTES}::int)
            AND s."firstSeenAt" < t."firstSeenAt"
            AND s."id" <> t."id"
            AND UPPER(BTRIM(s."symbol")) = UPPER(BTRIM(t."symbol"))
          OFFSET 0
        ) s ON true
        WHERE t."mintAddress" = ANY(${mints}::text[]) AND BTRIM(COALESCE(t."symbol", '')) <> ''
      ),
      counted AS (
        SELECT "mintAddress", COUNT("id")::int AS siblings FROM sib GROUP BY "mintAddress"
      )
      SELECT c."mintAddress", c.siblings,
        CASE WHEN c.siblings >= ${RELAUNCH_FARM_MIN_SIBLINGS} THEN (
          SELECT MAX(GREATEST(
            COALESCE(s."lastMcapUsd", 0),
            COALESCE(s."liveMarketCapUsd", 0),
            COALESCE(s."rejectPeak60mMcapUsd", 0),
            COALESCE((SELECT MAX(ts."marketCapUsd") FROM "TokenSnapshot" ts WHERE ts."tokenId" = s."id"), 0)
          ))
          FROM sib s WHERE s."mintAddress" = c."mintAddress" AND s."id" IS NOT NULL
        ) END AS peak
      FROM counted c`;
}
