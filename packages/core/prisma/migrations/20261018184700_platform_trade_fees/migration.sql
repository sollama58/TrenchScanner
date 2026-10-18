-- Fees saved (user ask 2026-10-18): each trade sent through our own Trade panel, with what it cost
-- in fees, so the Portfolio can compare it with other platforms' fees (schema.prisma PlatformTrade).
-- One new, empty table: no lock on anything that holds rows.
CREATE TABLE IF NOT EXISTS "PlatformTrade" (
    "signature" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "lamports" BIGINT NOT NULL,
    "platformFeeLamports" BIGINT NOT NULL DEFAULT 0,
    "networkFeeLamports" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "PlatformTrade_pkey" PRIMARY KEY ("signature")
);
CREATE INDEX IF NOT EXISTS "PlatformTrade_wallet_status_idx" ON "PlatformTrade"("wallet", "status");
