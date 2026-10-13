-- How many top holders are in a linked cluster, of how many were read (user ask 2026-10-13: show
-- Linked as "N/20"). Nullable columns with no default are catalog-only changes; the lock timeout
-- keeps a TokenSnapshot ALTER queued behind a long read from stalling the scanner
-- (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletsChecked" INTEGER;
