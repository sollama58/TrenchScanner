-- Likely KOL side wallets (KolPossibleSide), rebuilt hourly by the worker. A new table, so
-- nothing is locked.
CREATE TABLE IF NOT EXISTS "KolPossibleSide" (
    "wallet" TEXT NOT NULL,
    "kolWallet" TEXT NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "shared" INTEGER NOT NULL,
    "kolCoins" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KolPossibleSide_pkey" PRIMARY KEY ("wallet","kolWallet")
);

CREATE INDEX IF NOT EXISTS "KolPossibleSide_kolWallet_idx" ON "KolPossibleSide"("kolWallet");
