-- TokenSage rules 0.19.0 on the narrative cache: where the coin's creator fee goes
-- (market.creator_fee), how it is routed, the creator's own share, whether the split can still
-- change, and TokenSage's one-line summary. Null on older reads. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "feeDestination" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "feeMechanism" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "feeCreatorShare" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "feeMutable" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "feeSummary" TEXT;
