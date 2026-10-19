-- ApiUsage's (bucket) index repeats its primary key's leading column, which already serves the
-- 8-day prune, the only range reader (database audit 2026-10-17 P2-4): one index write less on
-- every per-minute flush. CONCURRENTLY, alone in its file, as 20261017193100_token_creator_index:
-- no lock on the live table, and Prisma sends a single-statement migration on its own. IF EXISTS
-- makes a retry safe.
DROP INDEX CONCURRENTLY IF EXISTS "ApiUsage_bucket_idx";
