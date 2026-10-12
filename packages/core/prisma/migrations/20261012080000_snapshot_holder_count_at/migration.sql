-- When each snapshot's holder count was read (RugCheck's report time), so holder growth compares
-- two readings rather than two scans that served the same cached report. Null on older rows.
-- Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "holderCountAt" TIMESTAMP(3);
