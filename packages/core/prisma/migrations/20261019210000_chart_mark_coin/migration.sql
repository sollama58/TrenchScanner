-- Each coin's chart-mark keep date and fill progress (apps/api/src/chartMarkFill.ts): opening a
-- coin's chart keeps its saved flagged trades 14 more days and fills in the ones nobody watched.
-- A new, empty table, so its index needs no CONCURRENTLY. Safe to re-run.
CREATE TABLE IF NOT EXISTS "ChartMarkCoin" (
    "mint" TEXT NOT NULL,
    "keepUntil" TIMESTAMP(3) NOT NULL,
    "filledFrom" TIMESTAMP(3),
    "filledTo" TIMESTAMP(3),
    "fillLeaseUntil" TIMESTAMP(3),
    "fillCalls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChartMarkCoin_pkey" PRIMARY KEY ("mint")
);

CREATE INDEX IF NOT EXISTS "ChartMarkCoin_keepUntil_idx" ON "ChartMarkCoin"("keepUntil");
