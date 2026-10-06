-- The composite score's adaptive weights (scoring/scoreWeights.ts): one row per fit run.
-- Re-runnable: IF NOT EXISTS throughout.
CREATE TABLE IF NOT EXISTS "ScoreWeightRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "momentum" DOUBLE PRECISION NOT NULL,
    "freshness" DOUBLE PRECISION NOT NULL,
    "holderQuality" DOUBLE PRECISION NOT NULL,
    "narrative" DOUBLE PRECISION NOT NULL,
    "adopted" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "ScoreWeightRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScoreWeightRun_adopted_createdAt_idx" ON "ScoreWeightRun"("adopted", "createdAt");
