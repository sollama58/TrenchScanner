-- Each wallet's composite risk score, rebuilt hourly from the trade tape (walletRiskJob.ts). New
-- table only; nothing existing changes.
CREATE TABLE IF NOT EXISTS "WalletRisk" (
    "wallet" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "appearances" INTEGER NOT NULL,
    "dumps" INTEGER NOT NULL,
    "fastExits" INTEGER NOT NULL,
    "snipes" INTEGER NOT NULL,
    "medianSupplyPct" DOUBLE PRECISION,
    "solIn" DOUBLE PRECISION NOT NULL,
    "solOut" DOUBLE PRECISION NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletRisk_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "WalletRisk_score_idx" ON "WalletRisk"("score");
