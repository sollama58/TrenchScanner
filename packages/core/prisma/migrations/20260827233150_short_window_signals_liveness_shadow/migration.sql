-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "lastLiveAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TokenSnapshot" ADD COLUMN     "buys1h" INTEGER,
ADD COLUMN     "buys5m" INTEGER,
ADD COLUMN     "priceChange1hPct" DOUBLE PRECISION,
ADD COLUMN     "priceChange24hPct" DOUBLE PRECISION,
ADD COLUMN     "priceChange5mPct" DOUBLE PRECISION,
ADD COLUMN     "priceChange6hPct" DOUBLE PRECISION,
ADD COLUMN     "sells1h" INTEGER,
ADD COLUMN     "sells5m" INTEGER,
ADD COLUMN     "volume1hUsd" DOUBLE PRECISION,
ADD COLUMN     "volume5mUsd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "CuratedShadowEmission" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "candidateOutcomeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "anchorPriceUsd" DOUBLE PRECISION NOT NULL,
    "anchorMcapUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CuratedShadowEmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CuratedShadowEmission_createdAt_idx" ON "CuratedShadowEmission"("createdAt");

-- CreateIndex
CREATE INDEX "CuratedShadowEmission_tokenId_createdAt_idx" ON "CuratedShadowEmission"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "CuratedShadowEmission_source_createdAt_idx" ON "CuratedShadowEmission"("source", "createdAt");

-- AddForeignKey
ALTER TABLE "CuratedShadowEmission" ADD CONSTRAINT "CuratedShadowEmission_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuratedShadowEmission" ADD CONSTRAINT "CuratedShadowEmission_candidateOutcomeId_fkey" FOREIGN KEY ("candidateOutcomeId") REFERENCES "CandidateOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: treat any token with a recent snapshot as alive, so the new liveness-prioritized
-- watchlist selection doesn't evict the currently-tracked in-band set on the deploy that
-- introduces it (snapshots only exist for tokens DexScreener returned market data for, which is
-- exactly what lastLiveAt records going forward). Tokens live-but-never-in-band re-establish
-- themselves via the normal stamping within one scan cycle if still within probation, or via
-- rediscovery - a one-time, self-healing gap.
UPDATE "Token" t
SET "lastLiveAt" = now()
WHERE EXISTS (
  SELECT 1 FROM "TokenSnapshot" s
  WHERE s."tokenId" = t."id" AND s."takenAt" > now() - interval '2 hours'
);
