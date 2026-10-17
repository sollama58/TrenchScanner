-- A creator's other launches (the token modal's Dev card, tokenProfile.ts) and the scan's dev
-- launch reading look tokens up by Token.creator. CONCURRENTLY, alone in its file, as
-- 20261005030000_candidate_outcome_kind_anchor_index: no write lock on the live table, and Prisma
-- sends a single-statement migration on its own. IF NOT EXISTS makes a retry safe; an interrupted
-- build can leave an INVALID index, which `DROP INDEX CONCURRENTLY "Token_creator_idx"` clears
-- before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Token_creator_idx" ON "Token"("creator");
