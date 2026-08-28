-- CreateTable
CREATE TABLE "MobileLinkCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "MobileLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "LinkedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MobileLinkCode_codeHash_key" ON "MobileLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "MobileLinkCode_userId_idx" ON "MobileLinkCode"("userId");

-- CreateIndex
CREATE INDEX "MobileLinkCode_expiresAt_idx" ON "MobileLinkCode"("expiresAt");

-- CreateIndex
CREATE INDEX "LinkedDevice_userId_idx" ON "LinkedDevice"("userId");

-- AddForeignKey
ALTER TABLE "MobileLinkCode" ADD CONSTRAINT "MobileLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedDevice" ADD CONSTRAINT "LinkedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
