-- Holder transfers count in Linked (user decision 2026-10-16). The funding-only figures stay
-- recorded beside the counted ones; nullable columns with no default are catalog-only changes.
-- KolPossibleSide gains the transfers that earned a transfer label (a small table), and
-- HolderTransferEvent keeps each linking transfer for the flags read across coins. IF NOT
-- EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletPctExTransfers" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletCountExTransfers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolBundledPctExTransfers" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "bundledSupplyPctExTransfers" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "bundledSupplyCountExTransfers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedClustersExTransfers" JSONB;

ALTER TABLE "KolPossibleSide" ADD COLUMN IF NOT EXISTS "transfers" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "HolderTransferEvent" (
    "signature" TEXT NOT NULL,
    "fromWallet" TEXT NOT NULL,
    "toWallet" TEXT NOT NULL,
    "mintAddress" TEXT NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HolderTransferEvent_pkey" PRIMARY KEY ("signature","fromWallet","toWallet")
);
CREATE INDEX IF NOT EXISTS "HolderTransferEvent_fromWallet_at_idx" ON "HolderTransferEvent"("fromWallet", "at");
CREATE INDEX IF NOT EXISTS "HolderTransferEvent_toWallet_at_idx" ON "HolderTransferEvent"("toWallet", "at");
CREATE INDEX IF NOT EXISTS "HolderTransferEvent_at_idx" ON "HolderTransferEvent"("at");
