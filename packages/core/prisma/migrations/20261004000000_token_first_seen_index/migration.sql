-- Built CONCURRENTLY so it never blocks the worker's inserts into Token while it builds on the
-- live table (a plain CREATE INDEX holds a write lock for the whole build - see
-- 20260903020000_snapshot_source_index for the time that took production down). CONCURRENTLY
-- cannot run inside a transaction block, which is why this file holds this one statement and
-- nothing else: Prisma sends a single-statement migration on its own. IF NOT EXISTS makes a retry
-- after an interrupted build safe; an interrupted CONCURRENTLY build can leave an INVALID index
-- behind, which `DROP INDEX CONCURRENTLY "Token_firstSeenAt_idx"` clears before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Token_firstSeenAt_idx" ON "Token"("firstSeenAt");
