-- AlterTable
ALTER TABLE "TokenSnapshot" ADD COLUMN     "emptyTop10WalletPct" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "UserFilter" ADD COLUMN     "maxEmptyTop10WalletPct" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "WalletHoldingsCache" (
    "address" TEXT NOT NULL,
    "otherHoldingsUsd" DOUBLE PRECISION NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletHoldingsCache_pkey" PRIMARY KEY ("address")
);

-- CreateIndex
CREATE INDEX "WalletHoldingsCache_checkedAt_idx" ON "WalletHoldingsCache"("checkedAt");
