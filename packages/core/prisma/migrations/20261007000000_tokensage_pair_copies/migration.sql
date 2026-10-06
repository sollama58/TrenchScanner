-- TokenSage rules 0.10.0 fields on the narrative cache: referent support, pair, recent copies,
-- and why a failed analysis failed. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "referentConfidence" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "referentSupport" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "pairKind" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "pairSymbol" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "copiesRecent" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "failReason" TEXT;
