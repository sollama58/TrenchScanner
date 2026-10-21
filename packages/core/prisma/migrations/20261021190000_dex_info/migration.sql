-- DexScreener enhanced token info (user ask 2026-10-21): a paid profile or a later update.
-- Nullable timestamps and booleans with a constant default are catalog-only on Postgres 11+.
-- The lock timeout keeps the ALTER from stalling the scanner behind a long read
-- (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "dexInfo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "dexInfoPaidAt" TIMESTAMP(3);
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "dexInfoUpdated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "dexInfoCheckedAt" TIMESTAMP(3);
