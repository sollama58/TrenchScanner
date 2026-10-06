-- Per-user Live feed appearance (theme, colors, spacing, card fields), saved with the wallet's
-- account so it follows the user across devices. Null = the default look. Safe to re-run.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "feedAppearance" JSONB;
