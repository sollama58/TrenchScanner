-- Holder-to-holder transfers (user ask 2026-10-16): Transferred Supply %, how many top holders
-- sent or got the coin from another, over how many, and the pairs for the bubble map, on each
-- snapshot. Nullable columns with no default are catalog-only changes. IF NOT EXISTS so a
-- partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "transferredSupplyPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "transferWalletCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "transferHoldersChecked" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "holderTransfers" JSONB;
