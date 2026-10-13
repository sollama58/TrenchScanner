-- How many top holders sit in a same-minute funding group (user ask 2026-10-13: show it as
-- "N/20"), and a filter cap on that count. Nullable columns with no default are catalog-only
-- changes; the lock timeout keeps a TokenSnapshot ALTER queued behind a long read from stalling
-- the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can
-- be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sameTimeFundedCount" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxSameTimeFundedCount" INTEGER;
