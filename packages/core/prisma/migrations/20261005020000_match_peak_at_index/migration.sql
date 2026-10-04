-- The frequent match-peaks pass repairs derived outcome columns for matches whose peak moved in
-- the last few minutes (repairOutcomeBookkeeping's sinceMinutes form), filtering on peakMcapAt -
-- with no index that was a sequential scan of every Match ever written, every cycle.
-- CONCURRENTLY, alone in its file, for the same reasons as 20261004000000_token_first_seen_index:
-- no write lock on the live table, and Prisma sends a single-statement migration on its own. IF NOT
-- EXISTS makes a retry safe; an interrupted build can leave an INVALID index, which
-- `DROP INDEX CONCURRENTLY "Match_peakMcapAt_idx"` clears before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Match_peakMcapAt_idx" ON "Match"("peakMcapAt");
