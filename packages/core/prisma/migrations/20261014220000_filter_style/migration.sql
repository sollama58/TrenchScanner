-- Per-filter card style (user ask 2026-10-14): a color and an icon the owner picks for each saved
-- filter, shown on the feed cards it raises in place of the Customize outline and accent. Nullable
-- columns with no default are catalog-only changes. IF NOT EXISTS so a partly-applied run can be
-- re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "color" TEXT;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "icon" TEXT;
