-- The coin each token's pricing pair trades against (DexScreener's quoteToken), for the cards'
-- quote pill. Nullable columns with no default are catalog-only changes; the lock timeout keeps
-- the ALTER from stalling the scanner behind a long read (scripts/migrate-deploy.sh retries it).
-- IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "quoteMint" TEXT;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "quoteSymbol" TEXT;
