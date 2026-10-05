-- The AI's daily spend ledger (curation/aiSpend.ts) and replay run costs. Safe to re-run: IF NOT EXISTS throughout.
CREATE TABLE IF NOT EXISTS "AiSpend" (
    "day" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "capUsd" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSpend_pkey" PRIMARY KEY ("day", "source")
);

ALTER TABLE "AiReplayRun" ADD COLUMN IF NOT EXISTS "estimatedCostUsd" DOUBLE PRECISION;
ALTER TABLE "AiReplayRun" ADD COLUMN IF NOT EXISTS "costUsd" DOUBLE PRECISION;
