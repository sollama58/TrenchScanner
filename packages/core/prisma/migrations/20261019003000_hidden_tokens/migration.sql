-- Tokens a user hid from the Live feed's Cards and Scope views (user ask 2026-10-19). A nullable
-- column with no default: a catalog-only change, no rewrite of User. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "hiddenTokens" JSONB;
