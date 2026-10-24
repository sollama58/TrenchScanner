-- The wallet that signed a coin's create transaction, read from the chain by Asyl's deployer read
-- (user bug report 2026-10-24: Pump.fun's `creator` follows a community takeover). A nullable
-- column with no default: a metadata-only change. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "deployer" TEXT;
