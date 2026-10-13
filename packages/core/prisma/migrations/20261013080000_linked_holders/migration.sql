-- Every top holder behind a linked-wallets reading, for the bubble map (core's wallets/linkedWallets.ts).
-- A nullable column with no default is a catalog-only change; the lock timeout keeps a TokenSnapshot
-- ALTER queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it).
-- IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedHolders" JSONB;
