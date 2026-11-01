-- The live-tape group readings the scan records beside the Block 0 figures (user ask 2026-11-01,
-- "where do we display these"): the same-size buy group on the coin's newest trades and at launch,
-- the newest buyers' mean hold time, and the recurring-cohort reading. Written by the scan from
-- 2026-11-01; null on older rows, on the fast lane's rows, and where the reading had no page or no
-- book. Display and record only: no filter or model reads them from here. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sameSizeGroupWallets" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sameSizeGroupSolShare" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "launchSameSizeWallets" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "recentBuyersHoldMean" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "cohortRecentBuyersPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "cohortRecentMaxSize" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "cohortCreatorLinked" BOOLEAN;
