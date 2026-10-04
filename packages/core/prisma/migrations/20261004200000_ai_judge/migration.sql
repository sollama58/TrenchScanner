-- AI judge: reviewer playbooks, offline replay runs, the learned AI blend, per-review audit
-- columns, and Claude's per-mint text scores. Re-runnable: every statement is IF NOT EXISTS, and
-- no index is built CONCURRENTLY (the new tables are empty).
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "aiTextScores" JSONB;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "aiTextScoredAt" TIMESTAMP(3);

ALTER TABLE "AiReview" ADD COLUMN IF NOT EXISTS "playbookId" TEXT;
ALTER TABLE "AiReview" ADD COLUMN IF NOT EXISTS "brief" TEXT;
ALTER TABLE "AiReview" ADD COLUMN IF NOT EXISTS "curatorProbability" DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS "AiPlaybook" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rationale" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "metrics" JSONB,

    CONSTRAINT "AiPlaybook_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiPlaybook_status_createdAt_idx" ON "AiPlaybook"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "AiReplayRun" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "batchId" TEXT,
    "model" TEXT NOT NULL,
    "playbookIds" TEXT[],
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scoredAt" TIMESTAMP(3),
    "metrics" JSONB,
    "error" TEXT,

    CONSTRAINT "AiReplayRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiReplayRun_status_idx" ON "AiReplayRun"("status");
CREATE INDEX IF NOT EXISTS "AiReplayRun_purpose_createdAt_idx" ON "AiReplayRun"("purpose", "createdAt");

CREATE TABLE IF NOT EXISTS "AiReplayVerdict" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "candidateOutcomeId" TEXT NOT NULL,
    "decision" TEXT,
    "probability2x" DOUBLE PRECISION,
    "probability4x" DOUBLE PRECISION,
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,

    CONSTRAINT "AiReplayVerdict_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiReplayVerdict_runId_idx" ON "AiReplayVerdict"("runId");
CREATE INDEX IF NOT EXISTS "AiReplayVerdict_playbookId_idx" ON "AiReplayVerdict"("playbookId");
DO $$ BEGIN
    ALTER TABLE "AiReplayVerdict" ADD CONSTRAINT "AiReplayVerdict_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "AiReplayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AiBlendModel" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "params" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "AiBlendModel_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiBlendModel_createdAt_idx" ON "AiBlendModel"("createdAt");
