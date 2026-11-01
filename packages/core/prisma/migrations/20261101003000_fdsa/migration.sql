-- FDSA (owner decision 2026-10-31): the AI desk that reviews every curated alert in two stages and
-- paper-trades its picks under its own adaptive exit plan (packages/core/src/fdsa). Its desk,
-- reviews, positions, fills and plan revisions, and a ledger column on AiSpend so FDSA's own daily
-- cap (FDSA_DAILY_BUDGET_USD) and the reviewer's (AI_DAILY_BUDGET_USD) never draw on each other.
-- Paper only: a CHECK holds `mode` to 'paper' until a later PR builds Live. Nothing here holds a
-- key or moves funds. Safe to re-run (see scripts/check-migrations.sh).
-- The foreign keys to "Token", "CandidateOutcome" and "CuratedAlert" take a brief lock on them,
-- and AiSpend's new column one on it: give up rather than queue the scanner behind them.
-- "ledger" has a constant default, so adding it rewrites nothing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "AiSpend" ADD COLUMN IF NOT EXISTS "ledger" TEXT NOT NULL DEFAULT 'reviewer';

CREATE TABLE IF NOT EXISTS "FdsaDesk" (
    "id" TEXT NOT NULL DEFAULT 'fdsa',
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "running" BOOLEAN NOT NULL DEFAULT false,
    "pausedReason" TEXT,
    "config" JSONB NOT NULL,
    "bankrollLamports" BIGINT NOT NULL,
    "cashLamports" BIGINT NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signalsFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lossWindowFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FdsaDesk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FdsaReview" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "candidateOutcomeId" TEXT,
    "curatedAlertId" TEXT,
    "positionId" TEXT,
    "stage" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "model" TEXT NOT NULL,
    "answeredBy" TEXT,
    "effort" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "playbookId" TEXT,
    "brief" TEXT,
    "decision" TEXT,
    "score" DOUBLE PRECISION,
    "probability2x" DOUBLE PRECISION,
    "probability4x" DOUBLE PRECISION,
    "conviction" DOUBLE PRECISION,
    "exitPlan" JSONB,
    "reasoning" TEXT,
    "risks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "refused" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL,
    "alertAt" TIMESTAMP(3) NOT NULL,
    "anchorPriceUsd" DOUBLE PRECISION NOT NULL,
    "anchorMcapUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FdsaReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FdsaPosition" (
    "id" TEXT NOT NULL,
    "deskId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "tokenId" TEXT,
    "sourceKind" TEXT NOT NULL DEFAULT 'fdsa',
    "reviewId" TEXT,
    "candidateOutcomeId" TEXT,
    "curatedAlertId" TEXT,
    "signalAt" TIMESTAMP(3) NOT NULL,
    "verdictAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "swapInLamports" BIGINT NOT NULL,
    "feesLamports" BIGINT NOT NULL DEFAULT 0,
    "tokensBought" TEXT NOT NULL,
    "tokensHeld" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "exitPlan" JSONB NOT NULL,
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "floorMultiple" DOUBLE PRECISION NOT NULL,
    "soldFraction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "partialsTaken" INTEGER NOT NULL DEFAULT 0,
    "peakMultiple" DOUBLE PRECISION,
    "lastMultiple" DOUBLE PRECISION,
    "lastPricedAt" TIMESTAMP(3),
    "triggersFired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRevisionAt" TIMESTAMP(3),
    "proceedsLamports" BIGINT NOT NULL DEFAULT 0,
    "closeRequested" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FdsaPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FdsaFill" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "lamports" BIGINT NOT NULL,
    "feeLamports" BIGINT NOT NULL,
    "tokens" TEXT NOT NULL,
    "multiple" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FdsaFill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FdsaPlanRevision" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "reviewId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "plan" JSONB,
    "proposed" JSONB,
    "multiple" DOUBLE PRECISION,
    "reason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FdsaPlanRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FdsaReview_dedupeKey_key" ON "FdsaReview"("dedupeKey");

CREATE INDEX IF NOT EXISTS "FdsaReview_createdAt_idx" ON "FdsaReview"("createdAt");

CREATE INDEX IF NOT EXISTS "FdsaReview_stage_createdAt_idx" ON "FdsaReview"("stage", "createdAt");

CREATE INDEX IF NOT EXISTS "FdsaReview_tokenId_idx" ON "FdsaReview"("tokenId");

CREATE INDEX IF NOT EXISTS "FdsaReview_candidateOutcomeId_idx" ON "FdsaReview"("candidateOutcomeId");

CREATE INDEX IF NOT EXISTS "FdsaReview_curatedAlertId_idx" ON "FdsaReview"("curatedAlertId");

CREATE INDEX IF NOT EXISTS "FdsaReview_positionId_idx" ON "FdsaReview"("positionId");

CREATE UNIQUE INDEX IF NOT EXISTS "FdsaPosition_reviewId_key" ON "FdsaPosition"("reviewId");

CREATE INDEX IF NOT EXISTS "FdsaPosition_status_idx" ON "FdsaPosition"("status");

CREATE INDEX IF NOT EXISTS "FdsaPosition_deskId_createdAt_idx" ON "FdsaPosition"("deskId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "FdsaPosition_deskId_mint_key" ON "FdsaPosition"("deskId", "mint");

CREATE INDEX IF NOT EXISTS "FdsaFill_positionId_idx" ON "FdsaFill"("positionId");

CREATE INDEX IF NOT EXISTS "FdsaPlanRevision_positionId_createdAt_idx" ON "FdsaPlanRevision"("positionId", "createdAt");

CREATE INDEX IF NOT EXISTS "AiSpend_day_ledger_idx" ON "AiSpend"("day", "ledger");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaReview_tokenId_fkey') THEN
    ALTER TABLE "FdsaReview" ADD CONSTRAINT "FdsaReview_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaReview_candidateOutcomeId_fkey') THEN
    ALTER TABLE "FdsaReview" ADD CONSTRAINT "FdsaReview_candidateOutcomeId_fkey" FOREIGN KEY ("candidateOutcomeId") REFERENCES "CandidateOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaReview_curatedAlertId_fkey') THEN
    ALTER TABLE "FdsaReview" ADD CONSTRAINT "FdsaReview_curatedAlertId_fkey" FOREIGN KEY ("curatedAlertId") REFERENCES "CuratedAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaReview_positionId_fkey') THEN
    ALTER TABLE "FdsaReview" ADD CONSTRAINT "FdsaReview_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "FdsaPosition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaPosition_deskId_fkey') THEN
    ALTER TABLE "FdsaPosition" ADD CONSTRAINT "FdsaPosition_deskId_fkey" FOREIGN KEY ("deskId") REFERENCES "FdsaDesk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaFill_positionId_fkey') THEN
    ALTER TABLE "FdsaFill" ADD CONSTRAINT "FdsaFill_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "FdsaPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaPlanRevision_positionId_fkey') THEN
    ALTER TABLE "FdsaPlanRevision" ADD CONSTRAINT "FdsaPlanRevision_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "FdsaPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One desk, and Paper only (owner decision 2026-10-31, decision 6): Live is refused by the
-- database too, not just by the API, until the PR that builds it lifts this.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaDesk_single_row') THEN
    ALTER TABLE "FdsaDesk" ADD CONSTRAINT "FdsaDesk_single_row" CHECK ("id" = 'fdsa');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaDesk_mode_paper') THEN
    ALTER TABLE "FdsaDesk" ADD CONSTRAINT "FdsaDesk_mode_paper" CHECK ("mode" = 'paper');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FdsaPosition_mode_paper') THEN
    ALTER TABLE "FdsaPosition" ADD CONSTRAINT "FdsaPosition_mode_paper" CHECK ("mode" = 'paper');
  END IF;
END $$;
