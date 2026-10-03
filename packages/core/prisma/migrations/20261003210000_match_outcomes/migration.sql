-- Grades user-filter alerts on the curated feed's verdict (fill price, 2x within 1h, 50% stop).
-- Nullable columns only: metadata-only on Postgres 11+, safe on the live Match table. No index
-- and no foreign key - see the comment on Match.candidateOutcomeId in schema.prisma.
ALTER TABLE "Match" ADD COLUMN "candidateOutcomeId" TEXT;
ALTER TABLE "Match" ADD COLUMN "peak1hReturnPct" DOUBLE PRECISION;
ALTER TABLE "Match" ADD COLUMN "maxDrawdown1hPct" DOUBLE PRECISION;
ALTER TABLE "Match" ADD COLUMN "hit2xIn1h" BOOLEAN;
ALTER TABLE "Match" ADD COLUMN "hit4xIn1h" BOOLEAN;
ALTER TABLE "Match" ADD COLUMN "disqualified" BOOLEAN;

-- The 4x and labelValue respect the stop all the way to the 4x, not only up to the 2x: the peak
-- before the price first fell to 50% of the fill. Null on existing rows (graded as before).
ALTER TABLE "CandidateOutcome" ADD COLUMN "peakBeforeStopPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CandidateOutcome" ADD COLUMN "stoppedAt" TIMESTAMP(3);
