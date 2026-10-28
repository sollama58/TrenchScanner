-- Asyl's daily use of other vendors' metered plans (full audit 2026-10-27, AP-2): Solana Tracker
-- top-traders reads, per reader and for the site. A new table, so nothing existing is locked for
-- long. Safe to re-run.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "AsylQuotaUse" (
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AsylQuotaUse_pkey" PRIMARY KEY ("key","day")
);
CREATE INDEX IF NOT EXISTS "AsylQuotaUse_day_idx" ON "AsylQuotaUse"("day");

-- Asyl maps' sizes, for a byte cap per account, and an admin takedown of a shared link (full
-- audit 2026-10-27, TR-2 and TR-3). Adding a column with a constant default rewrites nothing.
ALTER TABLE "AsylMap" ADD COLUMN IF NOT EXISTS "docBytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AsylMap" ADD COLUMN IF NOT EXISTS "sharedBytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AsylMap" ADD COLUMN IF NOT EXISTS "takenDownAt" TIMESTAMP(3);
-- The maps saved before this (a handful), sized once; a row sized already is left as it is.
UPDATE "AsylMap" SET "docBytes" = octet_length("doc"::text) WHERE "docBytes" = 0;
UPDATE "AsylMap" SET "sharedBytes" = octet_length("sharedDoc"::text)
 WHERE "sharedBytes" = 0 AND "sharedDoc" IS NOT NULL;
