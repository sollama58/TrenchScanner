-- The closed-candle store and its backfill queue (core's candles/, the worker's curveCandles.ts and
-- candleBackfill.ts, the API's GET /tokens/:mint/candles). New, empty tables, so their indexes need
-- no CONCURRENTLY. Safe to re-run.
CREATE TABLE IF NOT EXISTS "CandleChunk" (
    "mint" TEXT NOT NULL,
    "res" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "coverFrom" TIMESTAMP(3) NOT NULL,
    "coverTo" TIMESTAMP(3) NOT NULL,
    "bars" INTEGER NOT NULL,
    "coarse" BOOLEAN NOT NULL DEFAULT false,
    "data" BYTEA NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandleChunk_pkey" PRIMARY KEY ("mint", "res", "startAt", "source")
);

CREATE INDEX IF NOT EXISTS "CandleChunk_res_startAt_idx" ON "CandleChunk"("res", "startAt");

CREATE TABLE IF NOT EXISTS "CandleBackfill" (
    "mint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "pumpDone" BOOLEAN NOT NULL DEFAULT false,
    "poolIndex" INTEGER NOT NULL DEFAULT 0,
    "cursor" TIMESTAMP(3),
    "pages" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "CandleBackfill_pkey" PRIMARY KEY ("mint")
);

CREATE INDEX IF NOT EXISTS "CandleBackfill_doneAt_nextAt_idx" ON "CandleBackfill"("doneAt", "nextAt");
CREATE INDEX IF NOT EXISTS "CandleBackfill_requestedAt_idx" ON "CandleBackfill"("requestedAt");
