-- Statement-level statistics for GET /stats/db (full audit 2026-10-27, DB-9 and DB-19): which SQL
-- takes the database's time, and where the sequential scans on CandidateOutcome and Token come
-- from. Nothing else can name them from outside.
--
-- The view only answers when the server preloads the library (shared_preload_libraries); creating
-- the extension is harmless either way, and /stats/db reports "not available" with the reason
-- until it answers. A server or role that refuses the extension must not stop a deploy, so the
-- refusal is caught and logged instead. Safe to re-run.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements not created: %', SQLERRM;
END
$$;
