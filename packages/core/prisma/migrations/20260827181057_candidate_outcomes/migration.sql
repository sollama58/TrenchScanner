-- CreateTable
CREATE TABLE "CandidateOutcome" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anchorPriceUsd" DOUBLE PRECISION NOT NULL,
    "anchorMcapUsd" DOUBLE PRECISION NOT NULL,
    "features" JSONB NOT NULL,
    "score" DOUBLE PRECISION,
    "nextCheckAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastPriceUsd" DOUBLE PRECISION,
    "extended24h" BOOLEAN NOT NULL DEFAULT false,
    "peak1hPriceUsd" DOUBLE PRECISION NOT NULL,
    "peak1hAt" TIMESTAMP(3),
    "low1hPriceUsd" DOUBLE PRECISION NOT NULL,
    "lowBefore2xPriceUsd" DOUBLE PRECISION NOT NULL,
    "hit2xAt" TIMESTAMP(3),
    "peak24hPriceUsd" DOUBLE PRECISION NOT NULL,
    "peak24hAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "peak1hReturnPct" DOUBLE PRECISION,
    "maxDrawdown1hPct" DOUBLE PRECISION,
    "hit2xIn1h" BOOLEAN,
    "disqualified" BOOLEAN,
    "labelValue" DOUBLE PRECISION,
    "finalized24hAt" TIMESTAMP(3),
    "peak24hReturnPct" DOUBLE PRECISION,

    CONSTRAINT "CandidateOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateOutcome_tokenId_anchorAt_idx" ON "CandidateOutcome"("tokenId", "anchorAt");

-- CreateIndex
CREATE INDEX "CandidateOutcome_finalized24hAt_nextCheckAt_idx" ON "CandidateOutcome"("finalized24hAt", "nextCheckAt");

-- CreateIndex
CREATE INDEX "CandidateOutcome_anchorAt_idx" ON "CandidateOutcome"("anchorAt");

-- CreateIndex
CREATE INDEX "CandidateOutcome_finalizedAt_idx" ON "CandidateOutcome"("finalizedAt");

-- AddForeignKey
ALTER TABLE "CandidateOutcome" ADD CONSTRAINT "CandidateOutcome_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
