-- Model calls' market-cap highs banked from a DexScreener reading taken in the first minute after
-- the call (CALL_PEAK_READING_LAG_MS in liveMarketData.ts). DexScreener runs 45-60 s behind, so
-- such a reading shows the market from before the call; since calls are priced from a fresh
-- Jupiter quote (2026-10-12 ~16:00 UTC) that put pre-call wicks on cards as post-call highs (CASINO:
-- a $70k "high" on an $11k call). Calls since then are re-read from their snapshots past that first
-- minute; the old values are kept in CuratedPeakCorrection (see its comment for the undo). Earlier
-- calls were priced from DexScreener too, so the lag mostly cancelled there: left as they are.
-- Safe to re-run: the backup keeps the first value, and the UPDATE only touches rows still holding it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "CuratedPeakCorrection" (
    "alertId" TEXT NOT NULL,
    "peakMcapUsd" DOUBLE PRECISION NOT NULL,
    "peakMcapAt" TIMESTAMP(3) NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CuratedPeakCorrection_pkey" PRIMARY KEY ("alertId")
);

INSERT INTO "CuratedPeakCorrection" ("alertId", "peakMcapUsd", "peakMcapAt")
SELECT c.id, c."peakMcapUsd", c."peakMcapAt"
FROM "CuratedAlert" c
WHERE c."createdAt" >= TIMESTAMP '2026-10-12 16:00:00'
  AND c."peakMcapUsd" IS NOT NULL
  AND c."peakMcapAt" IS NOT NULL
  AND c."peakMcapAt" < c."createdAt" + INTERVAL '60 seconds'
ON CONFLICT ("alertId") DO NOTHING;

UPDATE "CuratedAlert" c
SET "peakMcapUsd" = best."marketCapUsd",
    "peakMcapAt"  = best."takenAt"
FROM "CuratedPeakCorrection" b
LEFT JOIN LATERAL (
  SELECT s."marketCapUsd", s."takenAt"
  FROM "CuratedAlert" c2
  JOIN "TokenSnapshot" s ON s."tokenId" = c2."tokenId"
  WHERE c2.id = b."alertId"
    AND s."takenAt" >= c2."createdAt" + INTERVAL '60 seconds'
    AND s."marketCapUsd" > c2."anchorMcapUsd"
  ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
  LIMIT 1
) best ON TRUE
WHERE c.id = b."alertId"
  AND c."peakMcapUsd" = b."peakMcapUsd"
  AND c."peakMcapAt" = b."peakMcapAt";
