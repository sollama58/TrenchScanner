-- Asyl (asyl.trenchscanner.app, user ask 2026-10-24): saved maps with their public snapshots, each
-- user's daily Helius credits for Asyl's chain reads, and the cache of parsed wallet flow reads.
-- Three new, empty tables; the foreign key takes a brief lock on User, bounded by the timeout.
-- Safe to re-run.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "AsylMap" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "shareSlug" TEXT,
    "sharedDoc" JSONB,
    "sharedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AsylMap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AsylMap_shareSlug_key" ON "AsylMap"("shareSlug");
CREATE INDEX IF NOT EXISTS "AsylMap_userId_updatedAt_idx" ON "AsylMap"("userId", "updatedAt");

CREATE TABLE IF NOT EXISTS "AsylCreditUse" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "reads" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AsylCreditUse_pkey" PRIMARY KEY ("userId", "day")
);
CREATE INDEX IF NOT EXISTS "AsylCreditUse_day_idx" ON "AsylCreditUse"("day");

CREATE TABLE IF NOT EXISTS "AsylFlowRead" (
    "wallet" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "flows" JSONB NOT NULL,
    "txs" INTEGER NOT NULL,
    CONSTRAINT "AsylFlowRead_pkey" PRIMARY KEY ("wallet")
);
CREATE INDEX IF NOT EXISTS "AsylFlowRead_readAt_idx" ON "AsylFlowRead"("readAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AsylMap_userId_fkey') THEN
    ALTER TABLE "AsylMap" ADD CONSTRAINT "AsylMap_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
