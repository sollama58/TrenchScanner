-- The candle backfill's pages on the pool it is paging (chart audit 2026-10-29, D2): a pool's first
-- page vouches for no quiet minutes up to a cursor another pool left. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandleBackfill" ADD COLUMN IF NOT EXISTS "poolPages" INTEGER NOT NULL DEFAULT 0;
