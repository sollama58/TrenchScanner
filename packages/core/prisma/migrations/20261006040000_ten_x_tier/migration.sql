-- The third tier (2026-10-06): a clean win that reached 10x within an hour of the alert, before
-- the 50% stop. CandidateOutcome tracks the hour's peak before the stop (peakBeforeStop60mPriceUsd,
-- stopped60mAt) and the verdict is copied onto curated alerts and filter matches. Nullable, no
-- default: catalog-only. Safe to re-run.
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "peakBeforeStop60mPriceUsd" DOUBLE PRECISION;
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "stopped60mAt" TIMESTAMP(3);
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "hit10xIn1h" BOOLEAN;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "hit10xIn1h" BOOLEAN;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "hit10xIn1h" BOOLEAN;

-- Rows graded before the tier existed: a clean win whose 30-minute peak before the stop was
-- already a 10x certainly made it within the hour, so those are credited. Nothing else can be
-- told from what was stored, so the rest stay null (not counted as 10x). Only nulls are touched.
UPDATE "CandidateOutcome"
SET "hit10xIn1h" = TRUE
WHERE "hit10xIn1h" IS NULL
  AND "finalizedAt" IS NOT NULL
  AND "hit2xIn1h" = TRUE
  AND "disqualified" = FALSE
  AND COALESCE("peakBeforeStopPriceUsd", "peak1hPriceUsd") >= 10 * "anchorPriceUsd";

UPDATE "CuratedAlert" a
SET "hit10xIn1h" = TRUE
FROM "CandidateOutcome" o
WHERE o."id" = a."candidateOutcomeId"
  AND a."hit10xIn1h" IS NULL
  AND o."hit10xIn1h" = TRUE;

-- Joined through the token too: Match.tokenId is indexed, candidateOutcomeId deliberately isn't.
UPDATE "Match" m
SET "hit10xIn1h" = TRUE
FROM "CandidateOutcome" o
WHERE m."tokenId" = o."tokenId"
  AND o."id" = m."candidateOutcomeId"
  AND m."hit10xIn1h" IS NULL
  AND o."hit10xIn1h" = TRUE;
