-- Trading bot (admin-only): custodial wallets sealed under KMS, bot settings, positions, the
-- swaps behind them, and withdrawals to the sign-in wallet.
-- Written to be safe to re-run (see scripts/check-migrations.sh).

CREATE TABLE IF NOT EXISTS "TradingWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "secretCiphertext" BYTEA NOT NULL,
    "secretIv" BYTEA NOT NULL,
    "secretAuthTag" BYTEA NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "keyProvider" TEXT NOT NULL,
    "keyRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingWallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingBot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "signalsFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingBot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "signalAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "entryLamports" BIGINT,
    "swapInLamports" BIGINT,
    "tokensBought" TEXT,
    "tokensHeld" TEXT NOT NULL DEFAULT '0',
    "decimals" INTEGER,
    "exitPlan" JSONB NOT NULL,
    "rungsTaken" INTEGER NOT NULL DEFAULT 0,
    "highMultiple" DOUBLE PRECISION,
    "lastMultiple" DOUBLE PRECISION,
    "lastPricedAt" TIMESTAMP(3),
    "proceedsLamports" BIGINT NOT NULL DEFAULT 0,
    "closeRequested" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingOrder" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rung" INTEGER,
    "signature" TEXT NOT NULL,
    "lastValidBlockHeight" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inAmount" TEXT NOT NULL,
    "quotedOut" TEXT NOT NULL,
    "lamportsDelta" BIGINT,
    "tokenDelta" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "TradingOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingWithdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "requestedLamports" BIGINT,
    "sentLamports" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "signature" TEXT,
    "lastValidBlockHeight" BIGINT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "TradingWithdrawal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TradingWallet_userId_key" ON "TradingWallet"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "TradingWallet_publicKey_key" ON "TradingWallet"("publicKey");

CREATE UNIQUE INDEX IF NOT EXISTS "TradingBot_userId_key" ON "TradingBot"("userId");

CREATE INDEX IF NOT EXISTS "TradingPosition_status_idx" ON "TradingPosition"("status");

CREATE INDEX IF NOT EXISTS "TradingPosition_userId_createdAt_idx" ON "TradingPosition"("userId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "TradingPosition_userId_mint_key" ON "TradingPosition"("userId", "mint");

CREATE UNIQUE INDEX IF NOT EXISTS "TradingOrder_signature_key" ON "TradingOrder"("signature");

CREATE INDEX IF NOT EXISTS "TradingOrder_status_idx" ON "TradingOrder"("status");

CREATE INDEX IF NOT EXISTS "TradingOrder_positionId_idx" ON "TradingOrder"("positionId");

CREATE UNIQUE INDEX IF NOT EXISTS "TradingWithdrawal_signature_key" ON "TradingWithdrawal"("signature");

CREATE INDEX IF NOT EXISTS "TradingWithdrawal_status_idx" ON "TradingWithdrawal"("status");

CREATE INDEX IF NOT EXISTS "TradingWithdrawal_userId_createdAt_idx" ON "TradingWithdrawal"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TradingWallet_userId_fkey') THEN
    ALTER TABLE "TradingWallet" ADD CONSTRAINT "TradingWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TradingBot_userId_fkey') THEN
    ALTER TABLE "TradingBot" ADD CONSTRAINT "TradingBot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TradingOrder_positionId_fkey') THEN
    ALTER TABLE "TradingOrder" ADD CONSTRAINT "TradingOrder_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "TradingPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
