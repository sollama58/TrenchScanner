-- The hidden composite Wallet Score and the counts behind it (user ask 2026-10-16,
-- notes/wallet-score-2026-10-16; core's wallets/walletScore.ts). WalletRisk is small and rebuilt
-- whole hourly, so the defaults are cheap; the lock timeout keeps the ALTER queued behind a long
-- read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a
-- partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "earlyBuys" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "early2x" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "early4x" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "own2x" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "own4x" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "walletScore" DOUBLE PRECISION;
