-- The win becomes 2x within 15 minutes of the alert and the goal 4x within 30 minutes (was both
-- within 1 hour). Re-grades every finalized row under the new windows, and adds the run peak's
-- timing. Safe to re-run: IF NOT EXISTS on the columns, and every UPDATE is a pure function of
-- columns it never writes (hit2xAt, anchorAt, the price aggregates), so a second pass is a no-op.

ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "runPeakMinutes" DOUBLE PRECISION;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "runPeakMinutes" DOUBLE PRECISION;

-- The 2x verdict re-grades exactly: hit2xAt is the first 2x the row saw, and lowBefore2xPriceUsd
-- froze at that same tick, so "won" is just "that first 2x landed inside 15 minutes", and the
-- disqualification follows unchanged.
--
-- The 4x re-grades exactly where the recorded path proves when the clean peak happened: the
-- window's peak landed inside 30 minutes, or the stop hit inside 30 minutes (the clean peak came
-- before it). A clean 4x whose peak came later, with no stop inside 30 minutes, may or may not
-- have crossed 4x in time; it is graded no (conservative). labelValue follows the 4x: log2 of
-- the clean peak for a goal, and for other wins the same, held under 2 (the 4x mark) - an upper
-- bound on the 30-minute value, which the trainer only reads as "won" and the hit rates as "won,
-- reached the goal".
--
-- Rows filled more than 15 minutes after the alert (an outage) are now ungraded for new calls;
-- old ones stay graded as losses here (their first 2x can't be inside 15 minutes either way).
WITH g AS (
  SELECT "id",
         ("hit2xAt" IS NOT NULL AND "hit2xAt" <= "anchorAt" + interval '15 minutes') AS won,
         ("lowBefore2xPriceUsd" <= 0.5 * "anchorPriceUsd") AS breached,
         COALESCE("peakBeforeStopPriceUsd", "peak1hPriceUsd") / "anchorPriceUsd" AS clean_multiple,
         (("peak1hAt" IS NOT NULL AND "peak1hAt" <= "anchorAt" + interval '30 minutes')
           OR ("stoppedAt" IS NOT NULL AND "stoppedAt" <= "anchorAt" + interval '30 minutes')) AS peak_in_goal_window
  FROM "CandidateOutcome"
  WHERE "finalizedAt" IS NOT NULL AND "anchorPriceUsd" > 0
),
l AS (
  SELECT "id", won,
         (won AND breached) AS dq,
         (won AND NOT breached AND clean_multiple >= 4 AND peak_in_goal_window) AS goal,
         clean_multiple
  FROM g
),
v AS (
  SELECT "id", won, dq, goal,
         CASE
           WHEN NOT won OR dq THEN 0
           WHEN goal THEN LEAST(log(2, GREATEST(clean_multiple, 1)::numeric)::float8, 6.643856189774724)
           ELSE LEAST(GREATEST(log(2, GREATEST(clean_multiple, 1)::numeric)::float8, 1), 1.999)
         END AS label
  FROM l
)
UPDATE "CandidateOutcome" co
SET "hit2xIn1h" = v.won,
    "hit2xIn15m" = v.won,
    "disqualified" = v.dq,
    "hit4xIn1h" = v.goal,
    "labelValue" = v.label
FROM v
WHERE co."id" = v."id"
  AND (co."hit2xIn1h" IS DISTINCT FROM v.won
    OR co."hit2xIn15m" IS DISTINCT FROM v.won
    OR co."disqualified" IS DISTINCT FROM v.dq
    OR co."hit4xIn1h" IS DISTINCT FROM v.goal
    OR co."labelValue" IS DISTINCT FROM v.label);

-- The feed's copies, from the rows above so a card's badge and the training set agree.
UPDATE "CuratedAlert" a
SET "hit2xIn15m" = o."hit2xIn15m",
    "hit2xIn1h" = o."hit2xIn1h",
    "hit4xIn1h" = o."hit4xIn1h",
    "disqualified" = o."disqualified"
FROM "CandidateOutcome" o
WHERE a."candidateOutcomeId" = o."id"
  AND o."finalizedAt" IS NOT NULL
  AND (a."hit2xIn1h" IS DISTINCT FROM o."hit2xIn1h"
    OR a."hit2xIn15m" IS DISTINCT FROM o."hit2xIn15m"
    OR a."hit4xIn1h" IS DISTINCT FROM o."hit4xIn1h"
    OR a."disqualified" IS DISTINCT FROM o."disqualified");

-- Alerts whose training row is already pruned: their own hit2xIn15m is the 15-minute 2x (from
-- the same first-2x tick), so the win and the disqualification re-grade exactly; the 4x keeps
-- its 1-hour flag, limited to wins (the path that would prove its timing is gone).
UPDATE "CuratedAlert" a
SET "hit2xIn1h" = a."hit2xIn15m",
    "disqualified" = (a."disqualified" AND a."hit2xIn15m"),
    "hit4xIn1h" = (a."hit4xIn1h" AND a."hit2xIn15m")
WHERE a."hit2xIn15m" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "CandidateOutcome" o WHERE o."id" = a."candidateOutcomeId")
  AND (a."hit2xIn1h" IS DISTINCT FROM a."hit2xIn15m"
    OR a."disqualified" IS DISTINCT FROM (a."disqualified" AND a."hit2xIn15m")
    OR a."hit4xIn1h" IS DISTINCT FROM (a."hit4xIn1h" AND a."hit2xIn15m"));

-- User-filter alerts graded from a "match" row. Reached through the token: Match.tokenId is
-- indexed, Match.candidateOutcomeId deliberately isn't (see schema.prisma).
UPDATE "Match" m
SET "hit2xIn1h" = o."hit2xIn1h",
    "hit4xIn1h" = o."hit4xIn1h",
    "disqualified" = o."disqualified"
FROM "CandidateOutcome" o
WHERE o."sampleKind" = 'match'
  AND o."finalizedAt" IS NOT NULL
  AND m."tokenId" = o."tokenId"
  AND m."candidateOutcomeId" = o."id"
  AND (m."hit2xIn1h" IS DISTINCT FROM o."hit2xIn1h"
    OR m."hit4xIn1h" IS DISTINCT FROM o."hit4xIn1h"
    OR m."disqualified" IS DISTINCT FROM o."disqualified");

-- When finished runs peaked, for the rows that already have a run peak.
UPDATE "CandidateOutcome"
SET "runPeakMinutes" = EXTRACT(EPOCH FROM ("peak24hAt" - "anchorAt")) / 60
WHERE "runPeakMinutes" IS NULL
  AND "finalized24hAt" IS NOT NULL
  AND "peak24hReturnPct" IS NOT NULL
  AND "peak24hAt" IS NOT NULL;

UPDATE "CuratedAlert" a
SET "runPeakMinutes" = o."runPeakMinutes"
FROM "CandidateOutcome" o
WHERE a."candidateOutcomeId" = o."id"
  AND a."runPeakMinutes" IS NULL
  AND o."runPeakMinutes" IS NOT NULL;
