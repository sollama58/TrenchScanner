-- The model-call 10x rate's own denominator: calls whose 10x verdict is in. It was divided by
-- the 2x-graded count, which holds clean winners whose 10x hour is still open, so the newest
-- buckets read low. Existing rows get the old denominator so the history reads as it did; the
-- rollup re-sums the trailing 72 hours exactly on its next run. Safe to re-run.
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "alertsTenXGraded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LighthouseDayLabel" ADD COLUMN IF NOT EXISTS "tenXGraded" INTEGER NOT NULL DEFAULT 0;
UPDATE "LighthouseHour" SET "alertsTenXGraded" = "alertsGraded" WHERE "alertsTenXGraded" = 0 AND "alertsGraded" > 0;
UPDATE "LighthouseDayLabel" SET "tenXGraded" = "graded" WHERE "tenXGraded" = 0 AND "graded" > 0;
