-- Which launchpad a coin came from (core's launchpads.ts), and the filters' launchpad option.
-- A nullable column with no default, and an array column with a constant default, are both
-- catalog-only changes; the lock timeout keeps a Token ALTER queued behind a long read from
-- stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied
-- run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "launchpad" TEXT;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "launchpads" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
