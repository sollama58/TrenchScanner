SET LOCAL lock_timeout = '5s';

-- The dashboard's Stream reads the tokens that most recently entered the curated band, newest
-- first, by firstInBandAt. Without an index that walked every token the watchlist window holds.
--
-- A plain CREATE INDEX inside the file's transaction, not CONCURRENTLY. The first version of this
-- file used CREATE INDEX CONCURRENTLY and deadlocked in production (2026-10-12, 40P01): the api,
-- worker and trainer deploy together, and CONCURRENTLY waits for every transaction already open,
-- including a peer's wait for Prisma's migration advisory lock, which this run was holding. It
-- left a failed migration row (rolled back by scripts/migrate-deploy.sh) and possibly an INVALID
-- index, dropped here before building. The build blocks writes to Token while it runs (reads go
-- on); lock_timeout stops it queueing behind a long read, and migrate-deploy.sh retries.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'Token_firstInBandAt_idx' AND NOT i.indisvalid
  ) THEN
    DROP INDEX "Token_firstInBandAt_idx";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Token_firstInBandAt_idx" ON "Token"("firstInBandAt");
