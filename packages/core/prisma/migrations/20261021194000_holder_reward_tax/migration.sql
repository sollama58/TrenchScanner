-- Holder-reward tax (user ask 2026-10-21): market.creator_fee.creator_fee_bps, in basis
-- points. 5 is 0.05%, 100 is 1%, 300 is 3%. Nullable, no default, no rewrite of existing rows.
-- Safe to re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "feeCreatorBps" INTEGER;
