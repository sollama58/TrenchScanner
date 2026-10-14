-- A model-alerted coin's bubble map over its top 100 holders (BubbleMapHolders), one row a coin,
-- written by the worker. A new table, so nothing is locked.
CREATE TABLE IF NOT EXISTS "BubbleMapHolders" (
    "mintAddress" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "holdersRead" INTEGER NOT NULL,
    "knownExtra" INTEGER NOT NULL,
    "holders" JSONB NOT NULL,
    "clusters" JSONB NOT NULL,
    "sameTimeClusters" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BubbleMapHolders_pkey" PRIMARY KEY ("mintAddress")
);

CREATE INDEX IF NOT EXISTS "BubbleMapHolders_computedAt_idx" ON "BubbleMapHolders"("computedAt");
