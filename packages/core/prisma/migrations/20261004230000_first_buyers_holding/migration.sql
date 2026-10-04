-- Nullable columns with no default: a catalog-only change, safe on the large TokenSnapshot table.
-- IF NOT EXISTS so a partly-applied run can be re-run.
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "firstBuyersHolding" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "firstBuyersSeen" INTEGER;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "minFirstBuyersHolding" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxFirstBuyersHolding" INTEGER;
