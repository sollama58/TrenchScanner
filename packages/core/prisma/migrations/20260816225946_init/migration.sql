-- CreateEnum
CREATE TYPE "AlertMode" AS ENUM ('REALTIME', 'DIGEST', 'BOTH', 'OFF');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFilter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "mcapMin" DOUBLE PRECISION NOT NULL DEFAULT 50000,
    "mcapMax" DOUBLE PRECISION NOT NULL DEFAULT 500000,
    "minVolumeMcapRatio" DOUBLE PRECISION,
    "minHolderGrowthPct" DOUBLE PRECISION,
    "maxTop10HolderPct" DOUBLE PRECISION,
    "minTokenAgeMinutes" INTEGER,
    "maxTokenAgeMinutes" INTEGER,
    "narrativeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minScore" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "alertMode" "AlertMode" NOT NULL DEFAULT 'BOTH',
    "linkCode" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "mintAddress" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "pairAddress" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hasTwitter" BOOLEAN NOT NULL DEFAULT false,
    "hasTelegram" BOOLEAN NOT NULL DEFAULT false,
    "hasWebsite" BOOLEAN NOT NULL DEFAULT false,
    "narrativeTags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenSnapshot" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "marketCapUsd" DOUBLE PRECISION NOT NULL,
    "liquidityUsd" DOUBLE PRECISION,
    "volume24hUsd" DOUBLE PRECISION,
    "volumeToMcapRatio" DOUBLE PRECISION,
    "buys24h" INTEGER,
    "sells24h" INTEGER,
    "holderCount" INTEGER,
    "holderGrowthPct" DOUBLE PRECISION,
    "top10HolderPct" DOUBLE PRECISION,
    "devWalletPct" DOUBLE PRECISION,
    "mintAuthorityActive" BOOLEAN,
    "freezeAuthorityActive" BOOLEAN,
    "lpBurned" BOOLEAN,
    "ageMinutes" INTEGER,
    "score" DOUBLE PRECISION,
    "rugScreenPassed" BOOLEAN NOT NULL DEFAULT false,
    "rugScreenReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "TokenSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" DOUBLE PRECISION NOT NULL,
    "deliveredDashboard" BOOLEAN NOT NULL DEFAULT true,
    "deliveredTelegram" BOOLEAN NOT NULL DEFAULT false,
    "digestSentAt" TIMESTAMP(3),

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "AuthNonce_nonce_key" ON "AuthNonce"("nonce");

-- CreateIndex
CREATE INDEX "AuthNonce_walletAddress_idx" ON "AuthNonce"("walletAddress");

-- CreateIndex
CREATE INDEX "UserFilter_userId_idx" ON "UserFilter"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_userId_key" ON "TelegramLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_chatId_key" ON "TelegramLink"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "Token_mintAddress_key" ON "Token"("mintAddress");

-- CreateIndex
CREATE INDEX "TokenSnapshot_tokenId_takenAt_idx" ON "TokenSnapshot"("tokenId", "takenAt");

-- CreateIndex
CREATE INDEX "TokenSnapshot_marketCapUsd_idx" ON "TokenSnapshot"("marketCapUsd");

-- CreateIndex
CREATE INDEX "Match_userId_matchedAt_idx" ON "Match"("userId", "matchedAt");

-- CreateIndex
CREATE INDEX "Match_tokenId_idx" ON "Match"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_userId_tokenId_filterId_matchedAt_key" ON "Match"("userId", "tokenId", "filterId", "matchedAt");

-- AddForeignKey
ALTER TABLE "UserFilter" ADD CONSTRAINT "UserFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenSnapshot" ADD CONSTRAINT "TokenSnapshot_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "UserFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "TokenSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
