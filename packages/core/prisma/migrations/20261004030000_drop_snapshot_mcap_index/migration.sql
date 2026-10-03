-- TokenSnapshot(marketCapUsd) has no reader: nothing ranges or orders snapshots by market cap
-- (filters and the curated band test it in memory, on the row the scan just built). It was 145MB
-- in production on 2026-10-03 with zero scans, and TokenSnapshot is the most-written table in the
-- database - every insert paid to maintain it.
--
-- CONCURRENTLY so the drop never blocks the worker's inserts, which is also why this file holds
-- this one statement and nothing else: CONCURRENTLY cannot run inside a transaction block, and
-- Prisma sends a single-statement migration on its own. IF EXISTS makes a re-run (after a failed
-- deploy, or on a database that never had the index) a no-op.
DROP INDEX CONCURRENTLY IF EXISTS "TokenSnapshot_marketCapUsd_idx";
