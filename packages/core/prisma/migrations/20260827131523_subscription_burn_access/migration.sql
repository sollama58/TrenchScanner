-- CreateEnum
CREATE TYPE "AccessSource" AS ENUM ('BURN', 'ADMIN_GRANT');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "source" "AccessSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BurnEvent" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3),
    "burnerWallet" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "rawAmount" TEXT NOT NULL,
    "monthsCredited" INTEGER NOT NULL,
    "userId" TEXT,
    "creditedAt" TIMESTAMP(3),
    "discoveredBy" TEXT NOT NULL DEFAULT 'reconciler',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BurnEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Whitelist" (
    "walletAddress" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Whitelist_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateTable
CREATE TABLE "BurnScanCursor" (
    "id" TEXT NOT NULL DEFAULT 'burn-scan',
    "lastSignature" TEXT,
    "scanFloor" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BurnScanCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_expiresAt_idx" ON "Subscription"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BurnEvent_signature_key" ON "BurnEvent"("signature");

-- CreateIndex
CREATE INDEX "BurnEvent_burnerWallet_idx" ON "BurnEvent"("burnerWallet");

-- CreateIndex
CREATE INDEX "BurnEvent_userId_idx" ON "BurnEvent"("userId");

-- CreateIndex
CREATE INDEX "BurnEvent_creditedAt_idx" ON "BurnEvent"("creditedAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BurnEvent" ADD CONSTRAINT "BurnEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
