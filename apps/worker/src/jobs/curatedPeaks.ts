import { prisma, createLogger, CALL_PEAK_READING_LAG_MS } from "@trenchscanner/core";

const logger = createLogger("curated-peaks");

/**
 * Brings every model call's market-cap high (CuratedAlert.peakMcapUsd) up to date from market
 * data already banked, the way recordMatchPeaks does for filter alerts (matchPeaks.ts) - no
 * upstream calls.
 *
 * Why: a call's own run peak (peak24hReturnPct) is only watched while its grading row is, which
 * is 30 minutes for a call that didn't double. Its card showed that, or the live market cap while
 * it was higher - so when the price came back down, the card's Peak walked back to the short
 * watch's figure. Kept here, the Peak only ever rises.
 *
 * Both statements only raise: the guards mean a row already at its high is not rewritten. A call
 * whose peak the coin's own trades keep (peakCheckedAt, candlePeaks.ts) is left alone: these
 * readings can be stale, and the candles are not.
 */
/** CALL_PEAK_READING_LAG_MS in whole seconds, for the statements below. */
const LAG_SECS = CALL_PEAK_READING_LAG_MS / 1000;

export async function recordCuratedPeaks(
  snapshotRetentionDays: number,
  options: {
    /** Only fold in readings from the last this-many minutes; omitted, every reading since the call. */
    sinceMinutes?: number;
    /** Only fold in readings from here on (the nightly sweep's bound); sinceMinutes wins when both are set. */
    snapshotsSince?: Date;
    /** Read a call's whole history when it has no high recorded yet, whatever the bound above. */
    backfillUnrecorded?: boolean;
    /** Only these tokens; omitted, every called token in the retention window. */
    tokenIds?: { snapshots: string[]; livePings: string[] };
  } = {},
): Promise<{ fromSnapshots: number; fromLivePings: number }> {
  const since =
    options.sinceMinutes !== undefined
      ? new Date(Date.now() - options.sinceMinutes * 60_000)
      : (options.snapshotsSince ?? new Date(0));
  const backfill = options.backfillUnrecorded ?? false;
  const snapshotTokens = options.tokenIds?.snapshots ?? null;
  const liveTokens = options.tokenIds?.livePings ?? null;

  const fromSnapshots =
    snapshotTokens !== null && snapshotTokens.length === 0
      ? 0
      : await prisma.$executeRaw`
    UPDATE "CuratedAlert" c
    SET "peakMcapUsd" = p.peak_mcap,
        "peakMcapAt"  = p.peak_at
    FROM (
      SELECT c2.id, best."marketCapUsd" AS peak_mcap, best."takenAt" AS peak_at
      FROM "CuratedAlert" c2
      JOIN LATERAL (
        SELECT s."marketCapUsd", s."takenAt"
        FROM "TokenSnapshot" s
        WHERE s."tokenId" = c2."tokenId"
          -- Readings from the first minute after the call still show the market before it
          -- (CALL_PEAK_READING_LAG_MS).
          AND s."takenAt" >= GREATEST(
            c2."createdAt" + MAKE_INTERVAL(secs => ${LAG_SECS}::int),
            CASE WHEN ${backfill} AND c2."peakMcapUsd" IS NULL THEN c2."createdAt" ELSE ${since} END
          )
        ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
        LIMIT 1
      ) best ON TRUE
      WHERE c2."peakCheckedAt" IS NULL
        AND c2."createdAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        AND (${snapshotTokens}::text[] IS NULL OR c2."tokenId" = ANY(${snapshotTokens}::text[]))
        AND best."marketCapUsd" > GREATEST(COALESCE(c2."peakMcapUsd", 0), c2."anchorMcapUsd")
    ) p
    -- Re-checked on the row being updated, so a pass that waited on the row lock never lowers a
    -- high another pass raised meanwhile (the same guard as recordMatchPeaks).
    WHERE c.id = p.id
      AND p.peak_mcap > COALESCE(c."peakMcapUsd", 0)
      AND c."peakCheckedAt" IS NULL
  `;
  const fromLivePings =
    liveTokens !== null && liveTokens.length === 0
      ? 0
      : await prisma.$executeRaw`
    UPDATE "CuratedAlert" c
    SET "peakMcapUsd" = t."liveMarketCapUsd",
        "peakMcapAt"  = t."liveDataAt"
    FROM "Token" t
    WHERE t.id = c."tokenId"
      AND c."peakCheckedAt" IS NULL
      AND c."createdAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
      AND (${liveTokens}::text[] IS NULL OR c."tokenId" = ANY(${liveTokens}::text[]))
      AND t."liveMarketCapUsd" IS NOT NULL
      AND t."liveDataAt" IS NOT NULL
      AND t."liveDataAt" >= c."createdAt" + MAKE_INTERVAL(secs => ${LAG_SECS}::int)
      AND (${backfill} OR t."liveDataAt" >= ${since})
      AND t."liveMarketCapUsd" > GREATEST(COALESCE(c."peakMcapUsd", 0), c."anchorMcapUsd")
  `;
  if (fromSnapshots > 0 || fromLivePings > 0) {
    logger.info("recorded new call peaks", { fromSnapshots, fromLivePings });
  }
  return { fromSnapshots, fromLivePings };
}

/** Tokens per statement in the nightly sweep - see recordCuratedPeaksFullSweep. */
const SWEEP_TOKENS_PER_BATCH = 100;

/**
 * The nightly sweep: every call in the retention window against its whole post-call history, a
 * batch of tokens at a time (one statement over everything is what made the match sweep run for
 * hours - see recordMatchPeaksFullSweep). A call with no high recorded yet - one made before the
 * column existed - reads its whole history once; the rest read from the sweep's bound on.
 */
export async function recordCuratedPeaksFullSweep(
  snapshotRetentionDays: number,
  /** As recordMatchPeaksFullSweep's: a recorded high already covers the readings before it. */
  snapshotsSince?: Date,
  /** As recordMatchPeaksFullSweep's; `onBatch` gets the high count raised so far. */
  resume: { afterTokenId?: string; onBatch?: (lastTokenId: string, raised: number) => Promise<void> } = {},
): Promise<number> {
  const after = resume.afterTokenId ?? "";
  const tokens = await prisma.$queryRaw<{ tokenId: string }[]>`
    SELECT DISTINCT "tokenId" FROM "CuratedAlert"
    WHERE "createdAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
      AND "tokenId" > ${after}
    ORDER BY "tokenId"`;
  let raised = 0;
  for (let i = 0; i < tokens.length; i += SWEEP_TOKENS_PER_BATCH) {
    const ids = tokens.slice(i, i + SWEEP_TOKENS_PER_BATCH).map((t) => t.tokenId);
    try {
      const r = await recordCuratedPeaks(snapshotRetentionDays, {
        snapshotsSince,
        backfillUnrecorded: true,
        tokenIds: { snapshots: ids, livePings: ids },
      });
      raised += r.fromSnapshots + r.fromLivePings;
    } catch (err) {
      logger.warn("call peak sweep batch failed, moving on", { tokens: ids.length, error: String(err) });
    }
    await resume.onBatch?.(ids[ids.length - 1]!, raised);
  }
  logger.info("call peak sweep complete", { tokens: tokens.length, raised });
  return raised;
}
