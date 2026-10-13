-- Solana Tracker's KOL roster, read daily by the worker's kol-wallets job. A new table: no lock on
-- anything the scanner reads. IF NOT EXISTS so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "KolWallet" (
    "wallet" TEXT NOT NULL,
    "name" TEXT,
    "twitter" TEXT,
    "realizedPnlUsd" DOUBLE PRECISION,
    "winRate" DOUBLE PRECISION,
    "lastTradeAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'solanatracker',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KolWallet_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "KolWallet_seenAt_idx" ON "KolWallet"("seenAt");
