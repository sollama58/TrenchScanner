-- The Side Wallet Checker's table (KolSideWallets), rebuilt hourly by the worker. A new table,
-- so nothing is locked.
CREATE TABLE IF NOT EXISTS "KolSideWallets" (
    "wallet" TEXT NOT NULL,
    "coins24h" INTEGER NOT NULL,
    "coins7d" INTEGER NOT NULL,
    "coins30d" INTEGER NOT NULL,
    "sides" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KolSideWallets_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "KolSideWallets_coins30d_idx" ON "KolSideWallets"("coins30d");
