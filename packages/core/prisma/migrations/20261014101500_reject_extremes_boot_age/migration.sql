-- Measurement only (audit 2026-10-14): a rejected coin's 60-minute peak and low after its first
-- safety-screen rejection (lane 3, M9), and how long the scanner had been up when a decision row
-- was banked (lane 7, F2). Nullable columns with no default are catalog-only changes, with no
-- backfill; the lock timeout keeps an ALTER queued behind a long read on these busy tables from
-- stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied
-- run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "screenRejectedAt" TIMESTAMP(3);
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "screenRejectedPriceUsd" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "screenRejectedMcapUsd" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "rejectPeak60mPriceUsd" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "rejectPeak60mMcapUsd" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "rejectPeak60mAt" TIMESTAMP(3);
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "rejectLow60mPriceUsd" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "rejectLow60mMcapUsd" DOUBLE PRECISION;

ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "bootAgeSeconds" INTEGER;
