import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("match-peaks");

export interface PeakRecordingResult {
  fromSnapshots: number;
  fromLivePings: number;
}

/**
 * Brings every Match's recorded peak up to date from market data this app has *already collected*.
 *
 * Why this exists: peak tracking used to happen only inside the nightly outcome-tracking job,
 * which fetches one fresh price per token and compares it to the recorded peak. That samples the
 * market once every 24 hours, which is the wrong resolution by two orders of magnitude for what
 * this product watches. A token that alerts at $80k, runs to $500k at 14:00 and settles back to
 * $70k by 20:00 reads $70k at the next 05:00 sample - *below* its own alert mcap - so no peak was
 * ever recorded and it never became Leaderboard-eligible. The tokens the Leaderboard exists to
 * celebrate are precisely the ones a once-a-day sample cannot see.
 *
 * Meanwhile the scan cycle already writes a TokenSnapshot for every in-band token every
 * SCAN_INTERVAL_MINUTES, and the live-price job already writes a market cap every minute for
 * tokens someone has open. That history was sitting in Postgres unused. Both statements below read
 * it and cost nothing upstream - no API call is made here at all.
 *
 * Both are idempotent: the `>` guards mean a row that is already correct is not rewritten, so
 * running this every scan cycle settles to zero writes rather than churning the table. Running it
 * for the first time against existing data backfills the entire history at once.
 *
 * A peak is only recorded once a token has actually traded *above* its alert market cap - a null
 * peakMcapUsd means "never went up", which is different from "went up 0%". See
 * reconcileMatchOutcome in outcomeTrackingJob.ts, which derives peakReturnPct/hitHundredPctAt
 * from whatever this records.
 */
export async function recordMatchPeaks(snapshotRetentionDays: number): Promise<PeakRecordingResult> {
  // Snapshots older than SNAPSHOT_RETENTION_DAYS are pruned by the cleanup job, so a match older
  // than that has no post-match snapshot history left to mine and this bound costs it nothing.
  // Without it the lateral join below runs once per Match row ever created.
  const fromSnapshots = await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = p.peak_mcap,
        "peakMcapAt"  = p.peak_at
    FROM (
      SELECT m2.id,
             best."marketCapUsd" AS peak_mcap,
             best."takenAt"      AS peak_at
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      JOIN LATERAL (
        SELECT s."marketCapUsd", s."takenAt"
        FROM "TokenSnapshot" s
        WHERE s."tokenId" = m2."tokenId"
          AND s."takenAt" >= m2."matchedAt"
        ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
        LIMIT 1
      ) best ON TRUE
      WHERE m2."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        AND best."marketCapUsd" > GREATEST(COALESCE(m2."peakMcapUsd", 0), alert."marketCapUsd")
    ) p
    WHERE m.id = p.id
  `;

  // The live ping is a real observation too, and a much finer-grained one - every minute, for
  // exactly the tokens someone is watching. It holds only the latest reading rather than a
  // history, which is why it supplements the snapshot scan above instead of replacing it.
  const fromLivePings = await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = t."liveMarketCapUsd",
        "peakMcapAt"  = t."liveDataAt"
    FROM "Token" t, "TokenSnapshot" alert
    WHERE t.id = m."tokenId"
      AND alert.id = m."snapshotId"
      AND t."liveMarketCapUsd" IS NOT NULL
      AND t."liveDataAt" IS NOT NULL
      AND t."liveDataAt" >= m."matchedAt"
      AND t."liveMarketCapUsd" > GREATEST(COALESCE(m."peakMcapUsd", 0), alert."marketCapUsd")
  `;

  if (fromSnapshots > 0 || fromLivePings > 0) {
    logger.info("recorded new match peaks", { fromSnapshots, fromLivePings });
  }
  return { fromSnapshots, fromLivePings };
}
