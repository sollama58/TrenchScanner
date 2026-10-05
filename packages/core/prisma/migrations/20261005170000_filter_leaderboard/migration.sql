-- The filter leaderboard: an owner opts a filter in with shareOnLeaderboard (off by default), and
-- its public record counts only the alerts raised since its criteria last changed
-- (criteriaChangedAt), so the record shown is the record of the settings a copier gets.
--
-- Existing filters start their record at createdAt: their edit history was never recorded.
-- Safe to re-run: IF NOT EXISTS adds, and the backfill only touches rows still NULL.

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "shareOnLeaderboard" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "criteriaChangedAt" TIMESTAMP(3);
UPDATE "UserFilter" SET "criteriaChangedAt" = "createdAt" WHERE "criteriaChangedAt" IS NULL;
ALTER TABLE "UserFilter" ALTER COLUMN "criteriaChangedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "UserFilter" ALTER COLUMN "criteriaChangedAt" SET NOT NULL;
