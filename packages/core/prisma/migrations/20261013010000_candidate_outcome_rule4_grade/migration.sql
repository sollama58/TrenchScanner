-- The rule-4 re-grade of rows a curated alert points at, kept beside their published rule-3 grade
-- so training and the exam can grade the models' own picks on the current rule. Nullable, no
-- default: a metadata-only change on the large table.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "rule4Grade" JSONB;
