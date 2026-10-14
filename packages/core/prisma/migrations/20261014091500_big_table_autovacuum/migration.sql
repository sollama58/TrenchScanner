SET LOCAL lock_timeout = '5s';

-- Per-table autovacuum thresholds on the four biggest, busiest tables (full audit 2026-10-14, F10).
--
-- Postgres's defaults wait for 20% of a table to be dead before vacuuming it and 10% to have
-- changed before re-analysing it. On TokenSnapshot (~3.75 M rows) that is ~750 k dead rows and
-- ~375 k changes: production went 11+ hours and 308 k inserts without either running, so the
-- planner's statistics lagged the nightly downsample by a day. Token carried 61.7 k dead rows with
-- no autovacuum yet; TokenWalletActivity re-writes a coin's rows on every re-read; CandidateOutcome
-- updates each open row every watch minute.
--
-- 0.02 to vacuum and 0.01 to analyse: TokenSnapshot is then vacuumed at ~75 k dead rows and
-- analysed every ~37 k changes (about every hour and a half of scan inserts); the smaller tables
-- proportionally sooner, still minutes apart at the most. Analyse at half the vacuum threshold
-- because stale statistics cost plans while dead rows only cost space, and an analyse is a cheap
-- sample. Lower than this and autovacuum would be re-reading TokenSnapshot's 2 GB heap many times
-- an hour for little gain. These are storage parameters only: no rewrite, and the lock taken is
-- SHARE UPDATE EXCLUSIVE (reads and writes carry on); lock_timeout still keeps it from queueing
-- behind a long trainer read. Prisma's schema can't express them, and its drift check ignores them.
ALTER TABLE "TokenSnapshot" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE "Token" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE "TokenWalletActivity" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE "CandidateOutcome" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
