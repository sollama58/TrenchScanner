-- Watchlist: remember each mint's last live market cap so the watchlist can keep near-band
-- tokens regardless of age (selectWatchlist).
ALTER TABLE "Token" ADD COLUMN "lastMcapUsd" DOUBLE PRECISION;

-- Fill-price grading: the watcher moves anchorPriceUsd to a realistic manual fill and keeps the
-- scan price in signalPriceUsd. sampleKind separates event / hourly / emission rows.
ALTER TABLE "CandidateOutcome" ADD COLUMN "entryAt" TIMESTAMP(3),
ADD COLUMN "signalPriceUsd" DOUBLE PRECISION,
ADD COLUMN "sampleKind" TEXT NOT NULL DEFAULT 'hourly';

-- Grandfather existing rows: they were graded from the scan price, so record that as their fill
-- rather than re-basing a half-watched label mid-flight.
UPDATE "CandidateOutcome" SET "entryAt" = "anchorAt", "signalPriceUsd" = "anchorPriceUsd";

-- Rows created only because a curator picked the token (an alert, shadow pick or AI review
-- anchored while the token's hourly sample was still fresh, so spacing was bypassed) are
-- emissions: keep them out of training. A pick that reused the cycle's own hourly sample keeps
-- 'hourly' - that row would have existed anyway. The tell for a bypass row is another row for
-- the same token anchored in the hour before it.
UPDATE "CandidateOutcome" co SET "sampleKind" = 'emission'
WHERE (
    EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."candidateOutcomeId" = co."id")
    OR EXISTS (SELECT 1 FROM "CuratedShadowEmission" x WHERE x."candidateOutcomeId" = co."id")
    OR EXISTS (SELECT 1 FROM "AiReview" x WHERE x."candidateOutcomeId" = co."id")
  )
  AND EXISTS (
    SELECT 1 FROM "CandidateOutcome" prev
    WHERE prev."tokenId" = co."tokenId"
      AND prev."id" <> co."id"
      AND prev."anchorAt" < co."anchorAt"
      AND prev."anchorAt" > co."anchorAt" - INTERVAL '60 minutes'
  );

CREATE INDEX "CandidateOutcome_tokenId_sampleKind_anchorAt_idx" ON "CandidateOutcome"("tokenId", "sampleKind", "anchorAt");
