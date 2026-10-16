-- Markers on the rows (user decision 2026-10-16, "markers everywhere"): which source a snapshot's
-- market figures came from, and whether a cached wallet valuation left a holding unpriced. A
-- nullable column and a defaulted boolean are catalog-only changes; the lock timeout keeps the
-- TokenSnapshot ALTER queued behind a long read from stalling the scanner
-- (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "marketSource" TEXT;
ALTER TABLE "WalletHoldingsCache" ADD COLUMN IF NOT EXISTS "unpriced" BOOLEAN NOT NULL DEFAULT false;
