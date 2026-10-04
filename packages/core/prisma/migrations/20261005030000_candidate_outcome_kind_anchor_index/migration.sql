-- The training job now loads the window's decision moments ("event" rows) and its hourly
-- background as two passes (sampleKind, newest first), and the Models tab's learning curve counts
-- event rows by day. Both filter on sampleKind over an anchorAt range; the existing (anchorAt)
-- index serves the range and then reads every hourly row to discard it. CONCURRENTLY, alone in
-- its file, as 20261005020000_match_peak_at_index: no write lock on the live table, and Prisma
-- sends a single-statement migration on its own. IF NOT EXISTS makes a retry safe; an interrupted
-- build can leave an INVALID index, which `DROP INDEX CONCURRENTLY
-- "CandidateOutcome_sampleKind_anchorAt_idx"` clears before re-running.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CandidateOutcome_sampleKind_anchorAt_idx" ON "CandidateOutcome"("sampleKind", "anchorAt");
