-- Fresh wallets among the top 25 holders as "N/25" (user decision 2026-10-14). Nullable columns
-- with no default are catalog-only changes; the lock timeout keeps a TokenSnapshot ALTER queued
-- behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS
-- so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "freshTopHolderCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "freshTopHoldersChecked" INTEGER;
