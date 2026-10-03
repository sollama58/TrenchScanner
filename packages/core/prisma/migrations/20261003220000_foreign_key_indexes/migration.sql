-- IF NOT EXISTS so a re-run after a failed or partial first attempt (P3009 in production,
-- 2026-10-03) succeeds whatever subset of these indexes the first attempt left behind.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CuratedAlert_snapshotId_idx" ON "CuratedAlert"("snapshotId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CuratedAlert_candidateOutcomeId_idx" ON "CuratedAlert"("candidateOutcomeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CuratedShadowEmission_candidateOutcomeId_idx" ON "CuratedShadowEmission"("candidateOutcomeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiReview_candidateOutcomeId_idx" ON "AiReview"("candidateOutcomeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiReview_curatedAlertId_idx" ON "AiReview"("curatedAlertId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Match_filterId_idx" ON "Match"("filterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Match_snapshotId_idx" ON "Match"("snapshotId");
