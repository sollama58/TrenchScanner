-- TokenSage rules 0.15.0 fields on the narrative cache: the coin's lineage (which copy of what),
-- the referent wave, the X account's credibility and the trend score - plus the "skip late
-- copies" filter criterion. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "lineageKind" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "lineageRank" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "lineageRankOf" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "lineageOfMint" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "originalAgeS" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "originalCurveProgress" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "originalComplete" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "siblings1h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "siblings6h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "siblings24h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "logoReuse24h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "waveLaunches1h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "waveLaunches6h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "waveLaunches24h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "waveRank24h" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "topCategoryInputs" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xCredibility" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xAccountAgeS" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xAccountMadeForCoin" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xReuseRank" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "trendScore" DOUBLE PRECISION;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "excludeLateCopies" BOOLEAN NOT NULL DEFAULT false;
