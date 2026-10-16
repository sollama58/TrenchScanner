-- When the mint launched on its bonding curve, from a launch source (user decision 2026-10-16: a
-- graduated coin's age is time since its launch, not since its pool opened). A nullable column
-- with no default is a catalog-only change; the lock timeout keeps the ALTER queued behind a long
-- read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a
-- partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "launchedAt" TIMESTAMP(3);
