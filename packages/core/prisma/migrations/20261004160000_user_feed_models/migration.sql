-- The combined feed's model checkboxes: several contestants per user instead of one, plus an
-- on/off switch for model alerts. Re-runnable: IF NOT EXISTS, and the backfill only touches rows
-- still empty. Constant defaults, so the ADD COLUMNs are metadata-only (no table rewrite).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "feedModels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "showModelAlerts" BOOLEAN NOT NULL DEFAULT true;

-- A user who had picked one model keeps it as their only checked box.
UPDATE "User"
SET "feedModels" = ARRAY["curatedModel"]
WHERE "curatedModel" IS NOT NULL AND cardinality("feedModels") = 0;
