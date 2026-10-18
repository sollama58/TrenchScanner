-- The TRADES panel: a Pro Mode wallet's own trades, read from the chain (schema.prisma ProTrade).
CREATE TABLE IF NOT EXISTS "ProTrade" (
    "wallet" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "lamports" BIGINT,
    "tokens" BIGINT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "entry" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProTrade_pkey" PRIMARY KEY ("wallet","signature","mint")
);

CREATE INDEX IF NOT EXISTS "ProTrade_wallet_at_idx" ON "ProTrade"("wallet", "at");
CREATE INDEX IF NOT EXISTS "ProTrade_wallet_mint_at_idx" ON "ProTrade"("wallet", "mint", "at");
CREATE INDEX IF NOT EXISTS "ProTrade_entry_at_idx" ON "ProTrade"("entry", "at");

-- How far back each wallet's trades have been read (schema.prisma ProTradeCursor).
CREATE TABLE IF NOT EXISTS "ProTradeCursor" (
    "wallet" TEXT NOT NULL,
    "lastSignature" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProTradeCursor_pkey" PRIMARY KEY ("wallet")
);
