-- The price path recorder's rows (the PricePathRecord model): young coins' second-by-second paths.
-- A new table, so no lock on a busy one; safe to re-run.
CREATE TABLE IF NOT EXISTS "PricePathRecord" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PricePathRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PricePathRecord_createdAt_idx" ON "PricePathRecord"("createdAt");
CREATE INDEX IF NOT EXISTS "PricePathRecord_mint_idx" ON "PricePathRecord"("mint");
