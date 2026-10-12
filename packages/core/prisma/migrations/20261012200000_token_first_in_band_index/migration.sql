-- The dashboard's Stream reads the tokens that most recently entered the curated band, newest
-- first, by firstInBandAt. Without an index that walked every token the watchlist window holds.
-- CONCURRENTLY, alone in its file, as 20261005020100_match_matched_at_index: no write lock on the
-- live table, and Prisma sends a single-statement migration on its own. IF NOT EXISTS makes a
-- retry safe; an interrupted build can leave an INVALID index, which
-- `DROP INDEX CONCURRENTLY "Token_firstInBandAt_idx"` clears before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Token_firstInBandAt_idx" ON "Token"("firstInBandAt");
