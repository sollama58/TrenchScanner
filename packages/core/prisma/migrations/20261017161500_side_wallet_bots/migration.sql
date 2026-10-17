-- The Admin Wallets section's "Bots and removed sides" view (user ask 2026-10-17): the wallets the
-- worker's kolSideWalletsJob.ts reads as bots, and the KOL side labels it took from them or kept
-- from them. Two new, empty tables; IF NOT EXISTS so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "SideWalletBot" (
    "wallet" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "coins30d" INTEGER,
    "coinShare" DOUBLE PRECISION,
    "kols" TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SideWalletBot_pkey" PRIMARY KEY ("wallet")
);
CREATE INDEX IF NOT EXISTS "SideWalletBot_computedAt_idx" ON "SideWalletBot"("computedAt");

CREATE TABLE IF NOT EXISTS "KolSideLabelRemoval" (
    "wallet" TEXT NOT NULL,
    "kolWallet" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "held" BOOLEAN NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "shared" INTEGER NOT NULL,
    "kolCoins" INTEGER NOT NULL,
    "hours" INTEGER NOT NULL,
    "transfers" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KolSideLabelRemoval_pkey" PRIMARY KEY ("wallet","kolWallet")
);
CREATE INDEX IF NOT EXISTS "KolSideLabelRemoval_lastAt_idx" ON "KolSideLabelRemoval"("lastAt");
