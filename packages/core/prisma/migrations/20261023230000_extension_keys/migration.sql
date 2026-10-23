-- Browser extension overlay (user ask 2026-10-23): read-only keys the extension authenticates
-- with, and the overlay's settings on the user. A new, empty table and a nullable column; the
-- foreign key takes a brief lock on User, bounded by the timeout. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "overlaySettings" JSONB;

CREATE TABLE IF NOT EXISTS "ExtensionKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "ExtensionKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionKey_secretHash_key" ON "ExtensionKey"("secretHash");
CREATE INDEX IF NOT EXISTS "ExtensionKey_userId_revokedAt_idx" ON "ExtensionKey"("userId", "revokedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionKey_userId_fkey') THEN
    ALTER TABLE "ExtensionKey" ADD CONSTRAINT "ExtensionKey_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
