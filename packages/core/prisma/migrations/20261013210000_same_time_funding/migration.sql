-- Top holders funded within a minute of each other (core's sameTimeClusters), and a filter bound on
-- it. Nullable columns with no default are catalog-only changes; the lock timeout keeps a
-- TokenSnapshot ALTER queued behind a long read from stalling the scanner
-- (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sameTimeFundedPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sameTimeClusterCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "sameTimeClusters" JSONB;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxSameTimeFundedPct" DOUBLE PRECISION;

-- The wallet modal's "funded in the same minute" list reads WalletFunder by funding time.
CREATE INDEX IF NOT EXISTS "WalletFunder_fundedAt_idx" ON "WalletFunder"("fundedAt");
