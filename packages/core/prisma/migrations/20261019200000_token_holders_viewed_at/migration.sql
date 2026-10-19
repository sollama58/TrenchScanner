SET LOCAL lock_timeout = '5s';

-- When someone last had the coin's bubble map open (Token.holdersViewedAt, user ask 2026-10-19):
-- the scan re-reads a watched coin's top holders every minute so its "Now" map keeps updating.
-- Null on every existing row. Safe to re-run.
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "holdersViewedAt" TIMESTAMP(3);
