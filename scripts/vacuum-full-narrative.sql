-- VACUUM FULL "TokenNarrative": give back the space the dropped analysis documents left behind.
--
-- Why this table and no other. The nightly cleanup (apps/worker/src/jobs/cleanupJob.ts,
-- "narrativeDocs") sets TokenNarrative.analysis to NULL once a coin's narrative has served the
-- training window. A plain VACUUM makes that space reusable for new rows of the same table, but
-- never shrinks the file, so on 2026-10-16 the table held ~1 GB of which most was dead: the
-- documents were written once and stripped once, and the table takes few new rows a day to refill
-- the holes. VACUUM FULL rewrites the table into a new file and returns the difference to the disk.
-- TokenSnapshot and CandidateOutcome churn daily and refill their own dead space, so a VACUUM FULL
-- there buys nothing for long and needs free space the size of the table to run; never run it on
-- them, and never run this one on a nearly full disk (the README's disk runbook).
--
-- What it costs. An ACCESS EXCLUSIVE lock on TokenNarrative for the rewrite (a few minutes at
-- ~1 GB on basic-4gb): every reader and writer of the table waits. The writers are the narrative
-- job on the scanner and the hourly curator training on the trainer, which reads narratives as
-- features; the API reads a row per token page. So run it after the 04:00 UTC cleanup has finished
-- (GET /health/worker shows the last run), between two curator trainings (they start on the hour,
-- CURATOR_TRAINING_INTERVAL_HOURS), and it needs free disk of at least the table's live size.
--
-- How. From the Render dashboard's shell for the database, or any psql with the database URL:
--
--   psql "$DATABASE_URL" -f scripts/vacuum-full-narrative.sql
--
-- The checks come first and print; the VACUUM FULL is the last statement. Delete it and run the
-- file to see the numbers alone.

-- 1. Size now: the table, its indexes and the TOAST file holding the big documents.
SELECT pg_size_pretty(pg_total_relation_size('"TokenNarrative"')) AS total,
       pg_size_pretty(pg_relation_size('"TokenNarrative"'))       AS heap,
       pg_size_pretty(pg_indexes_size('"TokenNarrative"'))        AS indexes,
       pg_size_pretty(COALESCE(pg_total_relation_size(reltoastrelid), 0)) AS toast
FROM pg_class WHERE relname = 'TokenNarrative';

-- 2. Live and dead rows, and when autovacuum last ran: dead rows stay in the count until a plain
--    VACUUM, so a high n_dead_tup with an old last_autovacuum says the space is still held.
SELECT n_live_tup, n_dead_tup, last_vacuum, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'TokenNarrative';

-- 3. How much of the live table still carries a document: the rewrite keeps these.
SELECT count(*) FILTER (WHERE analysis IS NOT NULL) AS with_document,
       count(*)                                     AS rows_total,
       pg_size_pretty(sum(pg_column_size(analysis))::bigint) AS document_bytes
FROM "TokenNarrative";

-- 4. Nothing else holding the table: a lock here means a job is mid-write, so wait for it.
SELECT pid, mode, granted, now() - query_start AS running, left(query, 80) AS query
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.relation = '"TokenNarrative"'::regclass AND a.pid <> pg_backend_pid();

-- 5. The rewrite. It waits for the locks above (lock_timeout stops it waiting forever behind a
--    long read; the statement itself may take minutes) and needs free disk of at least "heap" +
--    "toast" from step 1, less the dead share.
SET lock_timeout = '30s';
VACUUM (FULL, VERBOSE, ANALYZE) "TokenNarrative";

-- 6. Size afterwards, for the record.
SELECT pg_size_pretty(pg_total_relation_size('"TokenNarrative"')) AS total_after;
