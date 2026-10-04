-- Safe to re-run: every statement checks before it changes anything.

-- Users who never picked a model follow the best performer; anyone who has picked keeps their picks.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "followBestModel" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "alertPrefs" JSONB;

DO $$
BEGIN
  -- Only on the first run: once the champion table exists, users may have changed the toggle.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CuratorChampion') THEN
    UPDATE "User" SET "followBestModel" = false
     WHERE cardinality("feedModels") > 0 OR "curatedModel" IS NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CuratorChampion" (
    "id" TEXT NOT NULL,
    "contestant" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "liveGraded" INTEGER NOT NULL DEFAULT 0,
    "previous" TEXT,
    "reason" TEXT NOT NULL,
    "chosenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CuratorChampion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CuratorChampion_chosenAt_idx" ON "CuratorChampion"("chosenAt");
