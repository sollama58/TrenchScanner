-- The composite score's rescale, stored with each weight run (scoring/scorer.ts ScoreAnchor).
ALTER TABLE "ScoreWeightRun" ADD COLUMN IF NOT EXISTS "anchorScale" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "ScoreWeightRun" ADD COLUMN IF NOT EXISTS "anchorOffset" DOUBLE PRECISION NOT NULL DEFAULT 0;
