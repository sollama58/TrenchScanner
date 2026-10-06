-- TokenSage's X-post match (x.match) on the narrative cache. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xFit" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xVerdict" TEXT;
