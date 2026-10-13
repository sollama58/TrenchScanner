-- KOL counts on each scan, winner wallets buying and selling before the call, and the win side of
-- the wallet scores (user ask 2026-10-13, notes/holder-data-eval-2026-10-13). Nullable columns
-- with no default are catalog-only changes; the lock timeout keeps a TokenSnapshot ALTER queued
-- behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT
-- EXISTS so a partly-applied run can be re-run. WalletRisk is small and rebuilt whole hourly, so
-- its defaults are cheap.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolTopHolders" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolTopHolderPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolFirstBuyers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolRecentBuyers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolRecentSellers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "winnerRecentBuyers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "winnerRecentSellers" INTEGER;

ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "wins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "earlyWins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "winScore" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "WalletRisk_winScore_idx" ON "WalletRisk"("winScore");
