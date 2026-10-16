-- Free Access (Admin > Access): periods during which any wallet that signs in gets full access,
-- and the wallets each one enrolled. Two new tables with no foreign key to User, so nothing
-- existing is locked. IF NOT EXISTS and a guarded constraint so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "FreeAccessPeriod" (
    "id" TEXT NOT NULL,
    "signInStartsAt" TIMESTAMP(3) NOT NULL,
    "signInEndsAt" TIMESTAMP(3) NOT NULL,
    "accessEndsAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,
    "purgedAt" TIMESTAMP(3),
    CONSTRAINT "FreeAccessPeriod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FreeAccessPeriod_purgedAt_idx" ON "FreeAccessPeriod"("purgedAt");

CREATE TABLE IF NOT EXISTS "FreeAccessGrant" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAccount" BOOLEAN NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "FreeAccessGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FreeAccessGrant_periodId_walletAddress_key" ON "FreeAccessGrant"("periodId", "walletAddress");
CREATE INDEX IF NOT EXISTS "FreeAccessGrant_walletAddress_idx" ON "FreeAccessGrant"("walletAddress");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeAccessGrant_periodId_fkey') THEN
    ALTER TABLE "FreeAccessGrant" ADD CONSTRAINT "FreeAccessGrant_periodId_fkey"
      FOREIGN KEY ("periodId") REFERENCES "FreeAccessPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
