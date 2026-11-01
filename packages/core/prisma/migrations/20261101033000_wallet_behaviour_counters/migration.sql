-- Behaviour counters and the Wallet Score v2 on each wallet's risk row (data-uses evaluation
-- 2026-11-01, notes/data-uses-2026-11-01/report.md briefs 5-7). Nullable columns with no default are
-- catalog-only; the lock timeout keeps the ALTER from stalling the scanner behind a long read
-- (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "medianHoldSec" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "roundTrips" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "churnCoins" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "microBuyCoins" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "sellsIntoCalls" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "exitsBeforeStop" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "walletScoreV2" DOUBLE PRECISION;
