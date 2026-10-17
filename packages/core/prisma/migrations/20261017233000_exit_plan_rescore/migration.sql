-- The record of re-scoring returns under the exit plan of 2026-10-17 (see the ExitPlanRescore
-- model and apps/worker/src/jobs/exitPlanRescore.ts). A new table, so no lock on a busy one; safe
-- to re-run.
CREATE TABLE IF NOT EXISTS "ExitPlanRescore" (
    "outcomeId" TEXT NOT NULL,
    "previousSimReturnPct" DOUBLE PRECISION,
    "simReturnPct" DOUBLE PRECISION,
    "result" TEXT NOT NULL,
    "rescoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExitPlanRescore_pkey" PRIMARY KEY ("outcomeId")
);
