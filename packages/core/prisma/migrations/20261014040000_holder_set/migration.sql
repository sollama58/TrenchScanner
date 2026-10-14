-- One holder set for the cards and the screen (user ask 2026-10-13): launch snipers among the top
-- 25 holders as "N/25", Jupiter's live holder count on the snapshot, and a filter cap on the
-- snipers count. Nullable columns with no default are catalog-only changes; the lock timeout keeps
-- a TokenSnapshot ALTER queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh
-- retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sniperTopHolderCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sniperTopHoldersChecked" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "liveHolderCount" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxSniperTopHolderCount" INTEGER;
