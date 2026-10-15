-- A model-called coin's bubble map frozen at its first call (BubbleMapAtAlert), one row a coin,
-- written once by the worker. A new table, so nothing is locked.
CREATE TABLE IF NOT EXISTS "BubbleMapAtAlert" (
    "mintAddress" TEXT NOT NULL,
    "alertAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "holdersRead" INTEGER NOT NULL,
    "knownExtra" INTEGER NOT NULL,
    "holders" JSONB NOT NULL,
    "clusters" JSONB NOT NULL,
    "sameTimeClusters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BubbleMapAtAlert_pkey" PRIMARY KEY ("mintAddress")
);

CREATE INDEX IF NOT EXISTS "BubbleMapAtAlert_alertAt_idx" ON "BubbleMapAtAlert"("alertAt");
