-- How many top holders share a funder or a funding minute with another ("Bundled", user ask
-- 2026-10-13), and a filter cap on it. Nullable columns with no default are catalog-only changes;
-- the lock timeout keeps a TokenSnapshot ALTER queued behind a long read from stalling the scanner
-- (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "bundledWalletCount" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxBundledWalletCount" INTEGER;
