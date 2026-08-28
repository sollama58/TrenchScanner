-- AlterTable
ALTER TABLE "CandidateOutcome" ADD COLUMN     "hit2xIn15m" BOOLEAN,
ADD COLUMN     "hit4xIn1h" BOOLEAN;

-- AlterTable
ALTER TABLE "CuratedAlert" ADD COLUMN     "hit2xIn15m" BOOLEAN,
ADD COLUMN     "hit4xIn1h" BOOLEAN;

-- Re-grade every already-finalized training row under the new bar (2x within 15 minutes, still
-- disqualified by a pre-2x 50% drawdown; graded on the 1h peak). This is exact, not an
-- approximation: hit2xAt already records WHEN the first 2x landed, and peak1hPriceUsd already
-- records how far the row ran inside the goal window, so both new flags and the label follow
-- from data these rows have carried all along. Rewriting rather than leaving history under the
-- old definition on purpose - the trainer reads a 60-day window, and a window holding two
-- different meanings of "labelValue" teaches neither.
UPDATE "CandidateOutcome"
SET "hit2xIn15m" = ("hit2xAt" IS NOT NULL AND "hit2xAt" <= "anchorAt" + interval '15 minutes'),
    "hit4xIn1h" = ("peak1hPriceUsd" >= 4 * "anchorPriceUsd")
WHERE "finalizedAt" IS NOT NULL AND "anchorPriceUsd" > 0;

-- Disqualification is judged against the win window now: a 2x that only arrived at minute 40
-- is a miss, not a "stopped out", whatever its pre-2x trough did.
UPDATE "CandidateOutcome"
SET "disqualified" = ("hit2xIn15m" AND "lowBefore2xPriceUsd" <= 0.5 * "anchorPriceUsd")
WHERE "finalizedAt" IS NOT NULL AND "hit2xIn15m" IS NOT NULL;

-- log(2, x) is Postgres's base-2 log over numeric; the cap is log2(100), the same
-- LABEL_LOG2_CAP the application applies.
UPDATE "CandidateOutcome"
SET "labelValue" = CASE
      WHEN "hit2xIn15m" AND NOT "disqualified"
        THEN LEAST(log(2, ("peak1hPriceUsd" / "anchorPriceUsd")::numeric), 6.643856189774724)
      ELSE 0
    END
WHERE "finalizedAt" IS NOT NULL AND "hit2xIn15m" IS NOT NULL;

-- The feed's own copies, re-derived from the rows above so a card's badge and the training set
-- never disagree. Alerts whose training row has already been pruned keep their old-bar verdict
-- in hit2xIn1h and are rendered from it - see resolveOutcome.
UPDATE "CuratedAlert" a
SET "hit2xIn15m" = o."hit2xIn15m",
    "hit4xIn1h" = o."hit4xIn1h",
    "disqualified" = o."disqualified"
FROM "CandidateOutcome" o
WHERE a."candidateOutcomeId" = o."id" AND o."finalizedAt" IS NOT NULL;
