-- Nullable columns with no default: a catalog-only change, safe on the large TokenSnapshot table.
-- IF NOT EXISTS so a partly-applied run can be re-run.
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sniperTop10WalletPct" DOUBLE PRECISION;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxSniperTop10WalletPct" DOUBLE PRECISION;
