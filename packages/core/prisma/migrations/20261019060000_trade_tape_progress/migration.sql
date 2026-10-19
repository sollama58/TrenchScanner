-- The trade tape's reads in progress, saved at shutdown (worker tradeTapeJob.ts). Safe to re-run.
CREATE TABLE IF NOT EXISTS "TradeTapeProgress" (
    "lane" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeTapeProgress_pkey" PRIMARY KEY ("lane")
);
