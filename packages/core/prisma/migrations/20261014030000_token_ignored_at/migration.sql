-- Mayhem Mode tokens leave the watchlist for good once known (user decision 2026-10-13). A
-- nullable column with no default is a catalog-only change; the lock timeout keeps the ALTER
-- queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "ignoredAt" TIMESTAMP(3);
