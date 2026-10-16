-- The first buyers holding 0.1% of the supply or more (user decision 2026-10-16). A nullable column
-- with no default is a catalog-only change; the lock timeout keeps the TokenSnapshot ALTER queued
-- behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT
-- EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "firstBuyersHoldingCut" INTEGER;
