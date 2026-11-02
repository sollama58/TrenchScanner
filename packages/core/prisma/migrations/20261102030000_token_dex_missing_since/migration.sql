-- When the nightly outcome tracking first found no DexScreener market for a mint (audit
-- 2026-11-02, apps/worker outcomeTrackingJob.ts). A nullable column with no default is a
-- catalog-only change; the lock timeout keeps the Token ALTER queued behind a long read from
-- stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so it re-runs safely.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "dexMissingSince" TIMESTAMP(3);
