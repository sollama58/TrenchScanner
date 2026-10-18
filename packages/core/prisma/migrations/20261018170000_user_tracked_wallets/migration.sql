-- User Tracked wallets (user ask 2026-10-18): wallets a Pro Mode user labeled, shown as KOLs or as
-- User Tracked wallets to that user alone, and the probable sides the hourly side job reads for
-- them. Two new, empty tables: no lock on anything that holds rows.
CREATE TABLE IF NOT EXISTS "UserTrackedWallet" (
    "userId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserTrackedWallet_pkey" PRIMARY KEY ("userId", "wallet")
);
CREATE INDEX IF NOT EXISTS "UserTrackedWallet_wallet_idx" ON "UserTrackedWallet"("wallet");

CREATE TABLE IF NOT EXISTS "TrackedWalletSide" (
    "wallet" TEXT NOT NULL,
    "trackedWallet" TEXT NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "shared" INTEGER NOT NULL,
    "kolCoins" INTEGER NOT NULL,
    "hours" INTEGER NOT NULL,
    "transfers" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrackedWalletSide_pkey" PRIMARY KEY ("wallet", "trackedWallet")
);
CREATE INDEX IF NOT EXISTS "TrackedWalletSide_trackedWallet_idx" ON "TrackedWalletSide"("trackedWallet");
