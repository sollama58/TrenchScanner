-- A 4x now has to clear the same stop as the 2x: a row that traded at or below half its anchor
-- before doubling is disqualified, and its later 4x is not one any buyer of the alert held.
-- labelValue already scored those rows 0; this brings the 4x flag (and the feed's copy) in line.
UPDATE "CandidateOutcome"
SET "hit4xIn1h" = false
WHERE "finalizedAt" IS NOT NULL AND "hit4xIn1h" AND "disqualified";

UPDATE "CuratedAlert" a
SET "hit4xIn1h" = o."hit4xIn1h"
FROM "CandidateOutcome" o
WHERE a."candidateOutcomeId" = o."id" AND o."finalizedAt" IS NOT NULL AND a."hit4xIn1h" IS DISTINCT FROM o."hit4xIn1h";
