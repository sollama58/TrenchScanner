-- The Live tab's market bar (user ask 2026-10-23): the volume the scan's tokens traded per hour,
-- summed by the Lighthouse rollup while their snapshots are still kept (lighthouseRollupJob.ts
-- volumeHours). Null = not summed (an hour from before these columns, or past snapshot retention).
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "scanVolumeUsd" DOUBLE PRECISION;
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "scanVolumeTokens" INTEGER;
