-- Settles the 10x tier on clean winners graded before it was tracked, where what was stored
-- decides it: a winner whose finished 24h run never reached 10x cannot have reached it within the
-- hour. Only clean winners with no verdict are touched (losses need none: the 10x rate reads a
-- graded loss as a settled miss), so this stays small. Winners whose run did reach 10x but not
-- inside the first 30 minutes stay unknown and are left out of 10x rates. Safe to re-run.
UPDATE "CandidateOutcome"
SET "hit10xIn1h" = FALSE
WHERE "hit10xIn1h" IS NULL
  AND "hit2xIn1h" = TRUE
  AND "disqualified" = FALSE
  AND "finalized24hAt" IS NOT NULL
  AND "peak24hPriceUsd" < 10 * "anchorPriceUsd";

UPDATE "CuratedAlert"
SET "hit10xIn1h" = FALSE
WHERE "hit10xIn1h" IS NULL
  AND "hit2xIn1h" = TRUE
  AND "disqualified" = FALSE
  AND "outcomeFinalizedAt" IS NOT NULL
  AND "peak24hReturnPct" < 900;

-- Match carries the run peak once its anchor retires (Match.peak24hReturnPct).
UPDATE "Match"
SET "hit10xIn1h" = FALSE
WHERE "hit10xIn1h" IS NULL
  AND "hit2xIn1h" = TRUE
  AND "disqualified" = FALSE
  AND "peak24hReturnPct" < 900;
