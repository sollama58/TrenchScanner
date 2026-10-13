-- The exchange-funded share of each coin's largest holders (core's cexFundedReading), and two
-- filter bounds on it. Nullable columns with no default are catalog-only changes; the lock timeout
-- keeps a TokenSnapshot ALTER queued behind a long read from stalling the scanner
-- (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "cexFundedPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "cexFundedCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "cexFundedHolders" INTEGER;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "minCexFundedPct" DOUBLE PRECISION;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxCexFundedPct" DOUBLE PRECISION;
