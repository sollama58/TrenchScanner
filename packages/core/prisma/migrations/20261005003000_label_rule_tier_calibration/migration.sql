-- Label rule: which grading rule a training row's labels follow (see CandidateOutcome.labelRule).
-- Every statement is safe to re-run: IF NOT EXISTS on the columns, and the backfill only touches
-- rows still at the default.
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "labelRule" INTEGER NOT NULL DEFAULT 2;

-- Rows grandfathered by the fill-rule migration (20261003190000) had entryAt stamped equal to
-- anchorAt and were graded from the scan price; a fill-rule row's entryAt is always at least the
-- entry delay after its anchor. Those are rule 1.
UPDATE "CandidateOutcome"
SET "labelRule" = 1
WHERE "labelRule" = 2
  AND "entryAt" IS NOT NULL
  AND "entryAt" = "anchorAt";

-- Curated calls: the conviction tier and the calibrated 2x rate at emission.
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "tier" TEXT;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "calibratedPct" DOUBLE PRECISION;
