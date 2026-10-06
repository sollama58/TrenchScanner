-- The newest top-10 wallet readings on the token itself, so a card can show the last known
-- empty/fresh share when its alert snapshot and newest snapshot both lack one. Safe to re-run.
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "lastEmptyTop10WalletPct" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "lastFreshTop10WalletPct" DOUBLE PRECISION;
