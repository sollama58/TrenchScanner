-- The exit plan's trailing exit (curation/profitSim.ts): the running high since the plan's first
-- sale, and when and at what level the trail fired. Nullable, no default: a catalog-only change, no
-- rewrite of CandidateOutcome. Rows graded before this keep the return they were graded with. Safe
-- to re-run.
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "trailHighPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "trailExitAt" TIMESTAMP(3);
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "trailExitPriceUsd" DOUBLE PRECISION;
