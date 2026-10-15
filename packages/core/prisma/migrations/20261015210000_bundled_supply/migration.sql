-- Bundled % (user ask 2026-10-15): supply held by top holders that are linked or in a KOL's
-- bundle, each once, and how many holders that is, on each snapshot; and a ceiling on it as a
-- filter criterion. Nullable columns with no default are catalog-only changes. IF NOT EXISTS so a
-- partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "bundledSupplyPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "bundledSupplyCount" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxBundledSupplyPct" DOUBLE PRECISION;
