-- Helius data gaps (2026-11-25, after credits ran out from 2026-11-22 20:24 UTC for over a day):
-- the stretches the program ran without Helius's data, so training, the live scales and the exit
-- lab can leave out what they touched (packages/core/src/dataOutages.ts). A new table, filled by
-- the scanner's pipeline-watch from the shared stand-down and from the billed-usage buckets it
-- still holds (8 days, which reach back past the 11-22 outage). Safe to re-run.
CREATE TABLE IF NOT EXISTS "DataOutage" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataOutage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DataOutage_source_cause_startedAt_key" ON "DataOutage"("source", "cause", "startedAt");
CREATE INDEX IF NOT EXISTS "DataOutage_startedAt_idx" ON "DataOutage"("startedAt");
