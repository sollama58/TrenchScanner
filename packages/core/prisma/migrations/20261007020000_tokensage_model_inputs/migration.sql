-- The TokenSage fields the models, filters and score read per scan cycle, stored as columns so
-- no cycle has to open the raw analysis document. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xRelation" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xAuthorFollowers" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xPredatesTokenS" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xReuseCount" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "trendMatched" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "highFlagCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "warnFlagCount" INTEGER NOT NULL DEFAULT 0;
