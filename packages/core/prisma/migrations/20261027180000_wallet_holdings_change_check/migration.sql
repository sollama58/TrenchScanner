-- The empty-wallet change check (user decision 2026-10-27): a wallet's balances and SOL as of its
-- last full read, so an unchanged wallet is re-priced instead of read again. Nullable columns
-- with no default: a metadata-only change, no table rewrite. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "WalletHoldingsCache" ADD COLUMN IF NOT EXISTS "balances" JSONB;
ALTER TABLE "WalletHoldingsCache" ADD COLUMN IF NOT EXISTS "lamports" BIGINT;
ALTER TABLE "WalletHoldingsCache" ADD COLUMN IF NOT EXISTS "balancesReadAt" TIMESTAMP(3);
