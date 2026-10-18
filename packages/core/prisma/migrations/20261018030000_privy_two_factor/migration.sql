-- Privy sign-in and two-factor. User gains nullable columns only (no rewrite); the lock wait is
-- capped so a busy User table fails the deploy instead of stalling sign-ins. Safe to re-run.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "privyUserId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TwoFactorSettings" (
    "userId" TEXT NOT NULL,
    "totpSecret" TEXT,
    "pendingTotpSecret" TEXT,
    "lastTotpStep" INTEGER,
    "actions" TEXT[] DEFAULT ARRAY['signin', 'pair', 'export']::TEXT[],
    "buyOverLamports" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TwoFactorPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "TwoFactorPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TwoFactorBackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TwoFactorPasskey_credentialId_key" ON "TwoFactorPasskey"("credentialId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TwoFactorPasskey_userId_idx" ON "TwoFactorPasskey"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TwoFactorBackupCode_userId_idx" ON "TwoFactorBackupCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_privyUserId_key" ON "User"("privyUserId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TwoFactorSettings_userId_fkey') THEN
    ALTER TABLE "TwoFactorSettings" ADD CONSTRAINT "TwoFactorSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TwoFactorPasskey_userId_fkey') THEN
    ALTER TABLE "TwoFactorPasskey" ADD CONSTRAINT "TwoFactorPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TwoFactorBackupCode_userId_fkey') THEN
    ALTER TABLE "TwoFactorBackupCode" ADD CONSTRAINT "TwoFactorBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TwoFactorSpentToken" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorSpentToken_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TwoFactorSpentToken_expiresAt_idx" ON "TwoFactorSpentToken"("expiresAt");
