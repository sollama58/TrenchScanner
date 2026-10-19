-- Flagged wallets' trades the API's live trades follower saw (apps/api/src/chartFlaggedTrades.ts),
-- so the token chart marks them after the trade tape's 30 minutes past the call. Safe to re-run.
CREATE TABLE IF NOT EXISTS "ChartFlaggedTrade" (
    "sig" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "side" INTEGER NOT NULL,
    "mint" TEXT NOT NULL,
    "sol" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChartFlaggedTrade_pkey" PRIMARY KEY ("sig","wallet","side")
);

CREATE INDEX IF NOT EXISTS "ChartFlaggedTrade_mint_at_idx" ON "ChartFlaggedTrade"("mint", "at");
