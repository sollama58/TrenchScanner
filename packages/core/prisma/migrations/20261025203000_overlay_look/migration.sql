-- The browser extension's display choices, kept with the account so a reinstall gets them back
-- (user ask 2026-10-25). A nullable column with no default: a metadata-only change. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "overlayLook" JSONB;
