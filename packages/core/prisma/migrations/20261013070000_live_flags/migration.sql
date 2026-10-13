-- Flagged wallets trading a coin, read before the decision (core's wallets/liveFlags.ts).
-- Nullable columns with no default are catalog-only changes; the lock timeout keeps a TokenSnapshot
-- ALTER queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it).
-- IF NOT EXISTS throughout so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "flaggedBuyers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "flaggedSellers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "flaggedBuySol" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "flaggedSellSol" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "flaggedTrades" JSONB;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxFlaggedBuySol" DOUBLE PRECISION;
