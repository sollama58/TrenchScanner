-- One-time reclaim of index bloat left by the September/October backlog deletes
-- (notes/db-size-audit-2026-10-14/report.md, R4). REINDEX ... CONCURRENTLY takes no table lock:
-- readers and writers continue, each statement needs free disk equal to the index it rebuilds
-- (the largest is ~575 MB), and it cannot run inside a transaction, so run this with psql's
-- autocommit on (the default), one statement at a time, during a quiet hour:
--
--   psql "$DATABASE_URL" -f scripts/reindex-bloat.sql
--
-- Expected: TokenSnapshot's two indexes from 940 MB to ~400 MB, Token's two from 192 MB to ~70 MB.
-- Afterwards GET /stats/db shows the new sizes. Safe to re-run; a failed run leaves an invalid
-- index named *_ccnew that `DROP INDEX CONCURRENTLY` removes.
\timing on
REINDEX INDEX CONCURRENTLY "TokenSnapshot_pkey";
REINDEX INDEX CONCURRENTLY "TokenSnapshot_tokenId_takenAt_idx";
REINDEX INDEX CONCURRENTLY "Token_pkey";
REINDEX INDEX CONCURRENTLY "Token_mintAddress_key";
-- The heap's own free space (about 0.5 GB inside TokenSnapshot) is reused by new rows and needs
-- VACUUM FULL or pg_repack to return, which locks the table; not included.
