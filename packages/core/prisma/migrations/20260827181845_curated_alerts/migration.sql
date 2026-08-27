-- CreateTable
CREATE TABLE "CuratedAlert" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "candidateOutcomeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "anchorPriceUsd" DOUBLE PRECISION NOT NULL,
    "anchorMcapUsd" DOUBLE PRECISION NOT NULL,
    "peak1hReturnPct" DOUBLE PRECISION,
    "maxDrawdown1hPct" DOUBLE PRECISION,
    "hit2xIn1h" BOOLEAN,
    "disqualified" BOOLEAN,
    "peak24hReturnPct" DOUBLE PRECISION,
    "outcomeFinalizedAt" TIMESTAMP(3),

    CONSTRAINT "CuratedAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CuratedAlert_createdAt_idx" ON "CuratedAlert"("createdAt");

-- CreateIndex
CREATE INDEX "CuratedAlert_tokenId_createdAt_idx" ON "CuratedAlert"("tokenId", "createdAt");

-- AddForeignKey
ALTER TABLE "CuratedAlert" ADD CONSTRAINT "CuratedAlert_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuratedAlert" ADD CONSTRAINT "CuratedAlert_candidateOutcomeId_fkey" FOREIGN KEY ("candidateOutcomeId") REFERENCES "CandidateOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;
