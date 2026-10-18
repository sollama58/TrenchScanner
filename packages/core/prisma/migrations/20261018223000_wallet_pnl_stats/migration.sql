-- Per-coin profit or loss on each wallet's risk row, median and mean, in SOL and % (WalletModal).
-- Nullable columns with no default are catalog-only; the lock timeout keeps the ALTER from
-- stalling the scanner behind a long read (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "pnlCoins" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "medianPnlSol" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "avgPnlSol" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "medianPnlPct" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "avgPnlPct" DOUBLE PRECISION;
