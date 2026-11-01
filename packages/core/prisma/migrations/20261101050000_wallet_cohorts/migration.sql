-- Recurring wallet cohorts (data-uses evaluation 2026-11-01, notes/data-uses-2026-11-01/report.md
-- brief 3), rebuilt hourly by the trainer's walletCohortJob.ts. New tables, so nothing is locked.
CREATE TABLE IF NOT EXISTS "WalletCohort" (
    "wallet" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "coins" INTEGER NOT NULL,
    "creatorCoins" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletCohort_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "WalletCohort_cohortId_idx" ON "WalletCohort"("cohortId");

CREATE TABLE IF NOT EXISTS "WalletCohortPair" (
    "id" TEXT NOT NULL,
    "a" TEXT NOT NULL,
    "b" TEXT NOT NULL,
    "coins" INTEGER NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletCohortPair_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WalletCohortPair_a_idx" ON "WalletCohortPair"("a");
CREATE INDEX IF NOT EXISTS "WalletCohortPair_b_idx" ON "WalletCohortPair"("b");
