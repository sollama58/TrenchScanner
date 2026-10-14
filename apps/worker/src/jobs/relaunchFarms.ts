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
 * The same-ticker launches before each mint, for the block on model calls on relaunch farms (see
 * core's curation/relaunchFarm.ts). One query over the Token table the
 * discovery stream already fills; the siblings are fixed by the mint's first sighting, their peak
 * moves. A mint with no ticker, or not in the table, is left out (the block does not apply). On a
 * failed read every mint is left out, the same as unread.
 */
export async function resolveRelaunchSiblings(mints: string[]): Promise<Map<string, RelaunchSiblings>> {
  const out = new Map<string, RelaunchSiblings>();
  if (mints.length === 0) return out;
  try {
    const rows = await prisma.$queryRaw<{ mintAddress: string; siblings: number; peak: number | null }[]>`
      WITH sib AS (
        SELECT t."mintAddress", s."id", s."lastMcapUsd", s."liveMarketCapUsd", s."rejectPeak60mMcapUsd"
        FROM "Token" t
        LEFT JOIN "Token" s
          ON s."firstSeenAt" >= t."firstSeenAt" - make_interval(mins => ${RELAUNCH_FARM_WINDOW_MINUTES}::int)
          AND s."firstSeenAt" < t."firstSeenAt"
          AND s."id" <> t."id"
          AND UPPER(BTRIM(s."symbol")) = UPPER(BTRIM(t."symbol"))
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
    for (const r of rows) {
      out.set(r.mintAddress, { siblings: r.siblings, peakMcapUsd: Number(r.peak ?? 0) });
    }
  } catch (err) {
    logger.warn("relaunch sibling read failed; the relaunch-farm block is skipped this cycle", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}
