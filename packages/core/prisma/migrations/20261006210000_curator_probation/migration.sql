-- Takeover probation: a challenger that wins a learner seat on the exam waits to be confirmed on
-- fresh decision moments (curation/probation.ts). Re-runnable: every statement is IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "CuratorProbation" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recipe" JSONB NOT NULL,
    "generation" INTEGER NOT NULL,
    "parentName" TEXT,
    "examScore" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "challengerParams" JSONB NOT NULL,
    "laneParams" JSONB NOT NULL,
    "laneName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "resolvedReason" TEXT,

    CONSTRAINT "CuratorProbation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CuratorProbation_resolvedAt_idx" ON "CuratorProbation"("resolvedAt");
CREATE INDEX IF NOT EXISTS "CuratorProbation_startedAt_idx" ON "CuratorProbation"("startedAt");
