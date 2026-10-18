-- AlterTable
ALTER TABLE "User" ADD COLUMN     "privyUserId" TEXT;

-- CreateTable
CREATE TABLE "TwoFactorSettings" (
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
CREATE TABLE "TwoFactorPasskey" (
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
CREATE TABLE "TwoFactorBackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorPasskey_credentialId_key" ON "TwoFactorPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "TwoFactorPasskey_userId_idx" ON "TwoFactorPasskey"("userId");

-- CreateIndex
CREATE INDEX "TwoFactorBackupCode_userId_idx" ON "TwoFactorBackupCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_privyUserId_key" ON "User"("privyUserId");

-- AddForeignKey
ALTER TABLE "TwoFactorSettings" ADD CONSTRAINT "TwoFactorSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorPasskey" ADD CONSTRAINT "TwoFactorPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorBackupCode" ADD CONSTRAINT "TwoFactorBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "TwoFactorSpentToken" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorSpentToken_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "TwoFactorSpentToken_expiresAt_idx" ON "TwoFactorSpentToken"("expiresAt");
