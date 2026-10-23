-- The account's synced preferences beyond the feed's look (apps/api/src/userPrefs.ts): the Pro
-- trade defaults and the layout choices that used to stay in one browser. JSON, so a new section
-- needs no migration. Safe to re-run.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "uiPrefs" JSONB;
