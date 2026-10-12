-- Re-grading history from Pump.fun's minute candles (label rule 4): when a row was looked at, and
-- the grade it had before, so the re-grade can be read back or undone. Nullable, no default: a
-- metadata-only change on the large table.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "regradedAt" TIMESTAMP(3);
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "rule3Grade" JSONB;
