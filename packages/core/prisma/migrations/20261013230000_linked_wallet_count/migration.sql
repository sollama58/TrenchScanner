-- How many top holders are in a linked cluster, of how many were read (user ask 2026-10-13: show
-- Linked as "N/20") with a filter cap on it, and the CEX-funded filter bounds as counts of the top 20 ("#/20"), copied
-- from the % bounds they replace (rounded the way that keeps the filter no looser). Nullable
-- columns with no default are catalog-only changes; the lock timeout keeps a TokenSnapshot ALTER
-- queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletsChecked" INTEGER;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxLinkedWalletCount" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "minCexFundedCount" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxCexFundedCount" INTEGER;
UPDATE "UserFilter" SET "minCexFundedCount" = CEIL("minCexFundedPct" * 20 / 100)::int
  WHERE "minCexFundedPct" IS NOT NULL AND "minCexFundedCount" IS NULL;
UPDATE "UserFilter" SET "maxCexFundedCount" = FLOOR("maxCexFundedPct" * 20 / 100)::int
  WHERE "maxCexFundedPct" IS NOT NULL AND "maxCexFundedCount" IS NULL;
