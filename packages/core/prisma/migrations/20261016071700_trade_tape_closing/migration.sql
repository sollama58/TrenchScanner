-- The trade tape's closing read (user ask 2026-10-16): a dead coin's trades after the tape's window,
-- read once it leaves tracking and folded into the wallets already on its tape. Nullable columns
-- with no default are catalog-only changes. IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenTradeTape" ADD COLUMN IF NOT EXISTS "closeStatus" TEXT;
ALTER TABLE "TokenTradeTape" ADD COLUMN IF NOT EXISTS "closeRetryAt" TIMESTAMP(3);
ALTER TABLE "TokenTradeTape" ADD COLUMN IF NOT EXISTS "closedThrough" TIMESTAMP(3);
ALTER TABLE "TokenTradeTape" ADD COLUMN IF NOT EXISTS "closeTrades" INTEGER;
ALTER TABLE "TokenTradeTape" ADD COLUMN IF NOT EXISTS "closeCalls" INTEGER;
