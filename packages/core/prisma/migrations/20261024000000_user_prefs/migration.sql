-- The account's synced preferences beyond the feed's look (apps/api/src/userPrefs.ts): the Pro
-- trade defaults and the layout choices that used to stay in one browser. JSON, so a new section
-- needs no migration. A nullable column with no default is catalog-only; the timeout bounds the
-- brief lock on User. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "uiPrefs" JSONB;
