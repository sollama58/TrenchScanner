-- The fill target (owner decision 2026-11-28, program audit TG-1): a call wins when the price
-- reaches 2x the price a buyer could really have got (16 s after the call, plus 1%) within 30
-- minutes, before a 30% fall from it. Graded beside the existing labels, which keep training the
-- models (curation/fillTarget.ts). Every column is nullable with no default, so no row is
-- rewritten; the ALTERs give up rather than queue behind a long read (scripts/migrate-deploy.sh
-- retries). Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillAt" TIMESTAMP(3);
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillSource" TEXT;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillHit2xAt" TIMESTAMP(3);
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillStoppedAt" TIMESTAMP(3);
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillExitPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillWin" BOOLEAN;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "fillReturnPct" DOUBLE PRECISION;

ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "fillPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "fillSource" TEXT;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "fillWin" BOOLEAN;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "fillReturnPct" DOUBLE PRECISION;

ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "fillWin" BOOLEAN;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "fillReturnPct" DOUBLE PRECISION;
