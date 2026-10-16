-- Paper trading (admin-only): strategies that run the trading bot's settings on simulated SOL,
-- their positions, and the simulated fills behind them. Nothing here holds a key or moves funds.
-- Written to be safe to re-run (see scripts/check-migrations.sh).
-- The foreign key to "User" takes a brief lock on it: give up rather than queue readers behind it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "PaperStrategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "bankrollLamports" BIGINT NOT NULL,
    "cashLamports" BIGINT NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signalsFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "recentSkips" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperStrategy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaperPosition" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "signalAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "swapInLamports" BIGINT NOT NULL,
    "feesLamports" BIGINT NOT NULL DEFAULT 0,
    "tokensBought" TEXT NOT NULL,
    "tokensHeld" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "exitPlan" JSONB NOT NULL,
    "rungsTaken" INTEGER NOT NULL DEFAULT 0,
    "highMultiple" DOUBLE PRECISION,
    "peakMultiple" DOUBLE PRECISION,
    "lastMultiple" DOUBLE PRECISION,
    "lastPricedAt" TIMESTAMP(3),
    "proceedsLamports" BIGINT NOT NULL DEFAULT 0,
    "closeRequested" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaperFill" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rung" INTEGER,
    "lamports" BIGINT NOT NULL,
    "feeLamports" BIGINT NOT NULL,
    "tokens" TEXT NOT NULL,
    "multiple" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperFill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaperStrategy_userId_idx" ON "PaperStrategy"("userId");

CREATE INDEX IF NOT EXISTS "PaperStrategy_running_idx" ON "PaperStrategy"("running");

CREATE INDEX IF NOT EXISTS "PaperPosition_status_idx" ON "PaperPosition"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "PaperPosition_strategyId_mint_key" ON "PaperPosition"("strategyId", "mint");

CREATE INDEX IF NOT EXISTS "PaperFill_positionId_idx" ON "PaperFill"("positionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaperStrategy_userId_fkey') THEN
    ALTER TABLE "PaperStrategy" ADD CONSTRAINT "PaperStrategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaperPosition_strategyId_fkey') THEN
    ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "PaperStrategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaperFill_positionId_fkey') THEN
    ALTER TABLE "PaperFill" ADD CONSTRAINT "PaperFill_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "PaperPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
