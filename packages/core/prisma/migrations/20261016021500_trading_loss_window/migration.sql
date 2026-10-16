-- The trading bot's and paper strategies' daily loss limit counts positions closed after this.
-- Written to be safe to re-run (see scripts/check-migrations.sh).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TradingBot" ADD COLUMN IF NOT EXISTS "lossWindowFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PaperStrategy" ADD COLUMN IF NOT EXISTS "lossWindowFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
