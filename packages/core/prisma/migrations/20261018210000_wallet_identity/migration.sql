-- Helius wallet names kept 7 days (user decision 2026-10-18): each identity read bills 100
-- credits, and the API's memory cache was lost on every deploy (schema.prisma WalletIdentity,
-- apps/api walletIdentity.ts).
CREATE TABLE IF NOT EXISTS "WalletIdentity" (
    "wallet" TEXT NOT NULL,
    "identity" JSONB,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletIdentity_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "WalletIdentity_readAt_idx" ON "WalletIdentity"("readAt");
