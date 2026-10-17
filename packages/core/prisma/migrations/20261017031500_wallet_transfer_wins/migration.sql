-- Each wallet's win-sized trades fed by tokens transferred in (user ask 2026-10-17,
-- notes/winners-model-2026-10-17; worker's walletRiskJob.ts transferFedSql): the Winners seat reads a
-- Winner wallet only while this is 0 (core's wallets/winnerFollow.ts). Null, not 0, until the next
-- hourly rebuild counts it, so no Winner reads as clean before then. A nullable column with no
-- default is a catalog-only change; the lock timeout keeps the ALTER queued behind a long read from
-- stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied
-- run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "transferWins" INTEGER;
