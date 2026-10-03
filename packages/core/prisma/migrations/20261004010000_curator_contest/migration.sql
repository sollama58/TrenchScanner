-- The curator contest: every contestant (curation/contestants.ts) calls on its own ledger, the
-- training job stores one model row per contestant, and each user can pick whose calls they see.
-- Safe to re-run from any partly-applied state: every statement is IF NOT EXISTS or only touches
-- rows still NULL. No CONCURRENTLY - these tables are small (CuratedAlert grows by a few rows an
-- hour, CuratorModel by a handful per training run, User by sign-ups).

ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "CuratorModel" ADD COLUMN IF NOT EXISTS "contestant" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "curatedModel" TEXT;

-- Existing alerts join the ledger of the contestant that matches whoever made them: the
-- heuristic's become Rules', a promoted model's become its family's (logistic -> Linear,
-- boosted -> Trees - the same recipes those contestants train).
UPDATE "CuratedAlert" SET "model" = 'rules' WHERE "model" IS NULL AND "source" = 'heuristic-v1';
UPDATE "CuratedAlert" a
SET "model" = CASE WHEN m."kind" = 'gbdt-v1' THEN 'trees' ELSE 'linear' END
FROM "CuratorModel" m
WHERE a."model" IS NULL AND a."source" = m."id";
-- A model row pruned after 90 days leaves its alerts' source dangling; before boosted trees
-- existed every model was logistic.
UPDATE "CuratedAlert" SET "model" = 'linear' WHERE "model" IS NULL;

CREATE INDEX IF NOT EXISTS "CuratedAlert_model_createdAt_idx" ON "CuratedAlert"("model", "createdAt");
CREATE INDEX IF NOT EXISTS "CuratorModel_contestant_status_createdAt_idx" ON "CuratorModel"("contestant", "status", "createdAt");
