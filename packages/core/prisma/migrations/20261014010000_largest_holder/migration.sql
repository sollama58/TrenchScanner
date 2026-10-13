-- The largest single holder's share of supply on each scan, and an opt-in filter ceiling on it.
-- Nullable columns with no default are catalog-only changes. IF NOT EXISTS so a partly-applied
-- run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "largestHolderPct" DOUBLE PRECISION;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxLargestHolderPct" DOUBLE PRECISION;
