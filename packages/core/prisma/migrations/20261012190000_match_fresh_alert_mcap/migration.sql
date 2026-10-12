SET LOCAL lock_timeout = '5s';

-- A filter alert priced from a fresh quote (label rule 4): the market cap its grading row is
-- anchored at, which its Alert figure, peaks and Peak % now count from. NULL keeps the scan
-- snapshot's (DexScreener) market cap, as every existing row does. Nullable, no default: a
-- metadata-only change.
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "alertMcapUsd" DOUBLE PRECISION;
