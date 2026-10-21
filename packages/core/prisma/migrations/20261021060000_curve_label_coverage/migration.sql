-- Curve-tape label bookkeeping (2026-10-21). How much of the 30-minute window the
-- in-memory tape covered, and the last real dollar print the ratio scale may use.
-- Nullable, no default, no rewrite of existing rows. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "curveTapeCoveredMs" INTEGER;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "lastDollarPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "lastDollarAt" TIMESTAMP(3);
