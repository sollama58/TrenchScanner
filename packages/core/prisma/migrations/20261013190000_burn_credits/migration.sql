-- Burn Credits: the append-only ledger and the admin-editable price (core's subscription/credits.ts).
-- New tables only; IF NOT EXISTS throughout so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "BurnCreditEntry" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "burnSignature" TEXT,
    "rawAmount" TEXT,
    "tokensPerCredit" INTEGER,
    "utility" TEXT,
    "subject" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BurnCreditEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BurnCreditEntry_burnSignature_key" ON "BurnCreditEntry"("burnSignature");
CREATE INDEX IF NOT EXISTS "BurnCreditEntry_wallet_createdAt_idx" ON "BurnCreditEntry"("wallet", "createdAt");
CREATE INDEX IF NOT EXISTS "BurnCreditEntry_wallet_utility_subject_createdAt_idx" ON "BurnCreditEntry"("wallet", "utility", "subject", "createdAt");

CREATE TABLE IF NOT EXISTS "BurnCreditSettings" (
    "id" TEXT NOT NULL DEFAULT 'burn-credits',
    "tokensPerCredit" INTEGER NOT NULL DEFAULT 500,
    "tokenLookupCost" INTEGER NOT NULL DEFAULT 1,
    "walletLookupCost" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BurnCreditSettings_pkey" PRIMARY KEY ("id")
);
