-- Re-grade every already-finalized training row under the 1-hour bar (2x within 1 hour of the
-- anchor, still disqualified by a pre-2x 50% drawdown; graded on the 1h peak). Exact, not an
-- approximation: hit2xAt is only ever set inside the 1h window, and lowBefore2xPriceUsd froze at
-- that first 2x, so the verdict follows from data these rows already carry. Rewritten rather
-- than left under the 15-minute meaning because the trainer reads a 60-day window, and a window
-- holding two meanings of "labelValue" teaches neither.
UPDATE "CandidateOutcome"
SET "hit2xIn1h" = ("hit2xAt" IS NOT NULL),
    "hit2xIn15m" = ("hit2xAt" IS NOT NULL AND "hit2xAt" <= "anchorAt" + interval '15 minutes'),
    "hit4xIn1h" = ("peak1hPriceUsd" >= 4 * "anchorPriceUsd")
WHERE "finalizedAt" IS NOT NULL AND "anchorPriceUsd" > 0;

UPDATE "CandidateOutcome"
SET "disqualified" = ("hit2xIn1h" AND "lowBefore2xPriceUsd" <= 0.5 * "anchorPriceUsd")
WHERE "finalizedAt" IS NOT NULL AND "hit2xIn1h" IS NOT NULL;

-- The cap is log2(100), the same LABEL_LOG2_CAP the application applies.
UPDATE "CandidateOutcome"
SET "labelValue" = CASE
      WHEN "hit2xIn1h" AND NOT "disqualified"
        THEN LEAST(log(2, ("peak1hPriceUsd" / "anchorPriceUsd")::numeric), 6.643856189774724)
      ELSE 0
    END
WHERE "finalizedAt" IS NOT NULL AND "hit2xIn1h" IS NOT NULL;

-- The feed's own copies, re-derived from the rows above so a card's badge and the training set
-- never disagree. An alert whose training row was already pruned keeps its stored flags.
UPDATE "CuratedAlert" a
SET "hit2xIn15m" = o."hit2xIn15m",
    "hit2xIn1h" = o."hit2xIn1h",
    "hit4xIn1h" = o."hit4xIn1h",
    "disqualified" = o."disqualified"
FROM "CandidateOutcome" o
WHERE a."candidateOutcomeId" = o."id" AND o."finalizedAt" IS NOT NULL;

-- Winners that doubled between minute 15 and minute 60 were never put on the 24h watch (only
-- 15-minute winners were). Rows still inside their first 24h are put back on it so their
-- ultimate peak gets recorded like any other winner's; older ones keep the peak they have.
UPDATE "CandidateOutcome"
SET "extended24h" = true,
    "finalized24hAt" = NULL,
    "peak24hReturnPct" = NULL,
    "nextCheckAt" = now()
WHERE "finalizedAt" IS NOT NULL
  AND "hit2xIn1h" AND NOT "disqualified"
  AND NOT "extended24h"
  AND "anchorAt" > now() - interval '24 hours';
