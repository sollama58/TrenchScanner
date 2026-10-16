-- Transferred % as a filter criterion (user ask 2026-10-16): a ceiling on the share of supply that
-- moved holder to holder among the top 25 (TokenSnapshot.transferredSupplyPct). A nullable column
-- with no default is a catalog-only change. IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxTransferredSupplyPct" DOUBLE PRECISION;
