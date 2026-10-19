-- The scan reads the coins whose bubble map is open by Token.holdersViewedAt every cycle.
-- CONCURRENTLY, alone in its file, as 20261017193100_token_creator_index: no write lock on the live
-- table, and Prisma sends a single-statement migration on its own. IF NOT EXISTS makes a retry
-- safe; an interrupted build can leave an INVALID index, which
-- `DROP INDEX CONCURRENTLY "Token_holdersViewedAt_idx"` clears before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Token_holdersViewedAt_idx" ON "Token"("holdersViewedAt");
