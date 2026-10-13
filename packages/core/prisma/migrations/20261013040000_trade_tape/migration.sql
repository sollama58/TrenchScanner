-- The trade tape of called coins (apps/worker/src/jobs/tradeTapeJob.ts): one read per coin, what
-- each wallet did in it, and why each stopped call stopped. Two new tables and a nullable column
-- with no default (metadata-only on the large table). The foreign keys to Token take a brief lock
-- on it, so the lock_timeout covers them too.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "stopCause" JSONB;

CREATE TABLE IF NOT EXISTS "TokenTradeTape" (
    "tokenId" TEXT NOT NULL,
    "outcomeId" TEXT,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "launchAt" TIMESTAMP(3),
    "creator" TEXT,
    "trades" INTEGER NOT NULL DEFAULT 0,
    "wallets" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryAt" TIMESTAMP(3),
    CONSTRAINT "TokenTradeTape_pkey" PRIMARY KEY ("tokenId")
);

CREATE TABLE IF NOT EXISTS "TokenWalletActivity" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "buys" INTEGER NOT NULL DEFAULT 0,
    "sells" INTEGER NOT NULL DEFAULT 0,
    "solIn" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "solOut" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokensBought" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokensSold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "firstBuyAt" TIMESTAMP(3),
    "firstSellAt" TIMESTAMP(3),
    "heldAtAnchor" DOUBLE PRECISION,
    "heldPctAtAnchor" DOUBLE PRECISION,
    "boughtPct" DOUBLE PRECISION,
    "isCreator" BOOLEAN NOT NULL DEFAULT false,
    "firstBuyerRank" INTEGER,
    "launchSniper" BOOLEAN NOT NULL DEFAULT false,
    "top10AtAnchor" BOOLEAN NOT NULL DEFAULT false,
    "fastExit" BOOLEAN NOT NULL DEFAULT false,
    "dumpedIntoStop" BOOLEAN NOT NULL DEFAULT false,
    "dumpSol" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TokenWalletActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TokenTradeTape_readAt_idx" ON "TokenTradeTape"("readAt");
CREATE INDEX IF NOT EXISTS "TokenTradeTape_status_retryAt_idx" ON "TokenTradeTape"("status", "retryAt");
CREATE INDEX IF NOT EXISTS "TokenWalletActivity_wallet_idx" ON "TokenWalletActivity"("wallet");
CREATE INDEX IF NOT EXISTS "TokenWalletActivity_createdAt_idx" ON "TokenWalletActivity"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "TokenWalletActivity_tokenId_wallet_key" ON "TokenWalletActivity"("tokenId", "wallet");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TokenTradeTape_tokenId_fkey') THEN
    ALTER TABLE "TokenTradeTape" ADD CONSTRAINT "TokenTradeTape_tokenId_fkey"
      FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TokenWalletActivity_tokenId_fkey') THEN
    ALTER TABLE "TokenWalletActivity" ADD CONSTRAINT "TokenWalletActivity_tokenId_fkey"
      FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
