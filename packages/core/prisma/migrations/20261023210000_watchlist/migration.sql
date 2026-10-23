-- The Watchlist (user ask 2026-10-23): tokens a user starred, with the market cap and price they
-- had when added, in the user's order. A new, empty table; its foreign keys take a brief lock on
-- User and Token, bounded by the timeout. Safe to re-run.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "WatchlistItem" (
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedMarketCapUsd" DOUBLE PRECISION,
    "addedPriceUsd" DOUBLE PRECISION,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("userId", "tokenId")
);
-- A database that ran this file before the order was added gets the column too.
ALTER TABLE "WatchlistItem" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "WatchlistItem_tokenId_idx" ON "WatchlistItem"("tokenId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WatchlistItem_userId_fkey') THEN
    ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WatchlistItem_tokenId_fkey') THEN
    ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_tokenId_fkey"
      FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
