-- CreateTable
CREATE TABLE "AiReview" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "candidateOutcomeId" TEXT,
    "curatedAlertId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "decision" TEXT,
    "probability2x" DOUBLE PRECISION,
    "probability4x" DOUBLE PRECISION,
    "reasoning" TEXT,
    "risks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "anchorPriceUsd" DOUBLE PRECISION NOT NULL,
    "anchorMcapUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "AiReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiReview_createdAt_idx" ON "AiReview"("createdAt");

-- CreateIndex
CREATE INDEX "AiReview_tokenId_createdAt_idx" ON "AiReview"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "AiReview_decision_createdAt_idx" ON "AiReview"("decision", "createdAt");

-- AddForeignKey
ALTER TABLE "AiReview" ADD CONSTRAINT "AiReview_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReview" ADD CONSTRAINT "AiReview_candidateOutcomeId_fkey" FOREIGN KEY ("candidateOutcomeId") REFERENCES "CandidateOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReview" ADD CONSTRAINT "AiReview_curatedAlertId_fkey" FOREIGN KEY ("curatedAlertId") REFERENCES "CuratedAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

