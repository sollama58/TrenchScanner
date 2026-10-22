-- Model Alert API keys. The secret is shown once at generation and stored only as a hash.
-- A new table only; the lock timeout keeps the foreign key from stalling behind a long read on
-- "User" (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "UserApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "UserApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserApiKey_secretHash_key" ON "UserApiKey"("secretHash");
CREATE INDEX IF NOT EXISTS "UserApiKey_userId_revokedAt_idx" ON "UserApiKey"("userId", "revokedAt");
DO $$ BEGIN
  ALTER TABLE "UserApiKey" ADD CONSTRAINT "UserApiKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
