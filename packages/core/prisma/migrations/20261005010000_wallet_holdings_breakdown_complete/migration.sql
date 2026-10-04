-- Safe to re-run: a partly applied state only skips the column that already exists.
ALTER TABLE "WalletHoldingsCache" ADD COLUMN IF NOT EXISTS "breakdownComplete" BOOLEAN NOT NULL DEFAULT false;
