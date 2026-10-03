-- CreateIndex
CREATE INDEX "CuratedAlert_snapshotId_idx" ON "CuratedAlert"("snapshotId");

-- CreateIndex
CREATE INDEX "CuratedAlert_candidateOutcomeId_idx" ON "CuratedAlert"("candidateOutcomeId");

-- CreateIndex
CREATE INDEX "CuratedShadowEmission_candidateOutcomeId_idx" ON "CuratedShadowEmission"("candidateOutcomeId");

-- CreateIndex
CREATE INDEX "AiReview_candidateOutcomeId_idx" ON "AiReview"("candidateOutcomeId");

-- CreateIndex
CREATE INDEX "AiReview_curatedAlertId_idx" ON "AiReview"("curatedAlertId");

-- CreateIndex
CREATE INDEX "Match_filterId_idx" ON "Match"("filterId");

-- CreateIndex
CREATE INDEX "Match_snapshotId_idx" ON "Match"("snapshotId");
