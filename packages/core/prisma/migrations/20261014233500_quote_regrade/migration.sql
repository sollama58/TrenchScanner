-- The record of re-grading the outcomes of coins that trade only against another coin (see the
-- QuoteRegrade model and apps/worker/src/jobs/quoteRegrade.ts). A new table, so no lock on a busy one;
-- safe to re-run.
CREATE TABLE IF NOT EXISTS "QuoteRegrade" (
    "outcomeId" TEXT NOT NULL,
    "previous" JSONB NOT NULL,
    "result" TEXT NOT NULL,
    "regradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuoteRegrade_pkey" PRIMARY KEY ("outcomeId")
);
