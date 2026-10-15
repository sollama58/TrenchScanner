-- Trading bot retries: the priority fee each swap try paid (a retry after one that never landed
-- pays double), and how many times a withdrawal was resent after expiring unlanded.
ALTER TABLE "TradingOrder" ADD COLUMN IF NOT EXISTS "priorityFeeLamports" BIGINT;
ALTER TABLE "TradingWithdrawal" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
