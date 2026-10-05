-- Every call is graded from the price the token was detected and alerted at (user decision
-- 2026-10-05), not from a "realistic fill" (the higher of that price and the first price a minute
-- later, plus 1-3% slippage). Rows graded under the fill rule (labelRule 2) are re-graded here
-- from their recorded aggregates and become labelRule 3; new rows are graded from the alert price
-- by the watcher. Safe to re-run: every statement only touches labelRule 2 rows and moves them to
-- 3 in the same statement, and the copies are pure functions of the re-graded rows.
--
-- The base moves down to the alert price (signalPriceUsd), never up: the fill was never below it.
-- What the aggregates (all recorded from the fill onwards) prove under the lower base:
--   - a clean win stays a win: its 2x on the fill is a 2x on the alert price, and its trough
--     stayed above half the fill, so above half the alert price;
--   - a 2x disqualified by its trough wins if that trough stayed above half the alert price;
--   - a miss wins when the window's peak was at least 2x the alert price inside 15 minutes and
--     the window's low never reached half of it (no stop could have come first).
-- Anything else stays a miss (conservative). The minute or so between the alert and the fill was
-- never recorded, so a 2x or a stop inside it can't be seen. The 4x, labelValue and the window
-- percentages follow from the same peaks against the alert price, and the simulated return is
-- re-run under the exit plan with no slippage.

ALTER TABLE "CandidateOutcome" ALTER COLUMN "labelRule" SET DEFAULT 3;

-- Finalized rows.
WITH g AS (
  SELECT co."id",
         co."signalPriceUsd" AS sig,
         co."anchorPriceUsd" AS old_base,
         CASE WHEN co."features"->>'graduated' = '1' THEN 0.01 ELSE 0.03 END AS old_slip,
         (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS old_clean,
         (co."hit2xIn1h" AND COALESCE(co."disqualified", false)) AS old_dq,
         co."lowBefore2xPriceUsd" > 0.5 * co."signalPriceUsd" AS trough_ok,
         (co."peak1hAt" IS NOT NULL
           AND co."peak1hAt" <= co."anchorAt" + interval '15 minutes'
           AND co."peak1hPriceUsd" >= 2 * co."signalPriceUsd"
           AND co."low1hPriceUsd" > 0.5 * co."signalPriceUsd") AS peak_win,
         -- The stop on the fill is lifted when the window's low stayed above half the alert price;
         -- the whole window's peak then counts. Otherwise the stop on the alert price came no
         -- earlier than the recorded one, so the recorded pre-stop peak is a safe floor.
         CASE WHEN co."low1hPriceUsd" > 0.5 * co."signalPriceUsd" THEN co."peak1hPriceUsd"
              ELSE COALESCE(co."peakBeforeStopPriceUsd", co."peak1hPriceUsd") END AS clean_peak,
         COALESCE(co."peakBeforeStopPriceUsd", co."peak1hPriceUsd") AS old_clean_peak,
         ((co."peak1hAt" IS NOT NULL AND co."peak1hAt" <= co."anchorAt" + interval '30 minutes')
           OR (co."low1hPriceUsd" <= 0.5 * co."signalPriceUsd"
               AND co."stoppedAt" IS NOT NULL AND co."stoppedAt" <= co."anchorAt" + interval '30 minutes')) AS peak_in_goal_window,
         CASE WHEN co."peakBeforeStopPriceUsd" IS NOT NULL THEN co."stoppedAt" IS NOT NULL
              ELSE co."low1hPriceUsd" <= 0.5 * co."anchorPriceUsd" END AS old_stopped,
         co."low1hPriceUsd" <= 0.5 * co."signalPriceUsd" AS new_stopped,
         co."simReturnPct" AS old_sim,
         COALESCE(co."extended24h", false) AS extended,
         co."lastPriceUsd" AS last_price
  FROM "CandidateOutcome" co
  WHERE co."labelRule" = 2
    AND co."finalizedAt" IS NOT NULL
    AND co."signalPriceUsd" > 0
    AND co."anchorPriceUsd" > 0
),
l AS (
  SELECT g.*,
         (old_clean OR (old_dq AND trough_ok) OR peak_win) AS won,
         (old_dq AND NOT trough_ok AND NOT peak_win) AS dq,
         -- The exit ladder against each base: proceeds (in stakes) taken at 2x and 4x, and what was
         -- still held after them.
         (CASE WHEN old_clean_peak >= 2 * old_base THEN 1 ELSE 0 END
           + CASE WHEN old_clean_peak >= 4 * old_base THEN 2 ELSE 0 END) AS old_tp,
         (1 - CASE WHEN old_clean_peak >= 2 * old_base THEN 0.5 ELSE 0 END
            - CASE WHEN old_clean_peak >= 4 * old_base THEN 0.5 ELSE 0 END) AS old_held,
         (CASE WHEN clean_peak >= 2 * sig THEN 1 ELSE 0 END
           + CASE WHEN clean_peak >= 4 * sig THEN 2 ELSE 0 END) AS new_tp,
         (1 - CASE WHEN clean_peak >= 2 * sig THEN 0.5 ELSE 0 END
            - CASE WHEN clean_peak >= 4 * sig THEN 0.5 ELSE 0 END) AS new_held
  FROM g
),
c AS (
  SELECT l.*,
         (won AND clean_peak >= 4 * sig AND peak_in_goal_window) AS goal,
         -- The window-close price, recovered from the old simulated return where the old plan was
         -- still holding at the close (not stopped, not fully sold); else the last price seen when the
         -- row was not kept on the 24h watch (then it is the window's last price).
         CASE WHEN old_sim IS NOT NULL AND old_held > 0 AND NOT old_stopped
              THEN (((old_sim / 100 + 1) / (1 - old_slip)) - old_tp) / old_held * old_base
              WHEN NOT extended THEN last_price
         END AS close_price
  FROM l
),
v AS (
  SELECT c."id", sig, won, dq, goal,
         CASE
           WHEN NOT won THEN 0
           WHEN goal THEN LEAST(log(2, GREATEST(clean_peak / sig, 1)::numeric)::float8, 6.643856189774724)
           ELSE LEAST(GREATEST(log(2, GREATEST(clean_peak / sig, 1)::numeric)::float8, 1), 1.999)
         END AS label,
         CASE
           WHEN new_held <= 0 THEN (new_tp - 1) * 100
           WHEN new_stopped THEN (new_tp + new_held * 0.5 - 1) * 100
           WHEN close_price IS NOT NULL AND close_price > 0 THEN (new_tp + new_held * close_price / sig - 1) * 100
         END AS sim
  FROM c
)
UPDATE "CandidateOutcome" co
SET "anchorPriceUsd" = v.sig,
    "labelRule" = 3,
    "hit2xIn1h" = (v.won OR v.dq),
    "hit2xIn15m" = (v.won OR v.dq),
    "disqualified" = v.dq,
    "hit4xIn1h" = v.goal,
    "labelValue" = v.label,
    "hit2xAt" = CASE
                  WHEN v.won AND NOT COALESCE(co."hit2xIn1h", false) THEN co."peak1hAt"
                  ELSE co."hit2xAt"
                END,
    "stoppedAt" = CASE WHEN co."low1hPriceUsd" > 0.5 * v.sig THEN NULL ELSE co."stoppedAt" END,
    "peakBeforeStopPriceUsd" = CASE
                                 WHEN co."stoppedAt" IS NOT NULL AND co."low1hPriceUsd" > 0.5 * v.sig
                                   THEN co."peak1hPriceUsd"
                                 ELSE co."peakBeforeStopPriceUsd"
                               END,
    "peak1hReturnPct" = (co."peak1hPriceUsd" / v.sig - 1) * 100,
    "maxDrawdown1hPct" = (co."low1hPriceUsd" / v.sig - 1) * 100,
    "peak24hReturnPct" = CASE WHEN co."peak24hReturnPct" IS NOT NULL THEN (co."peak24hPriceUsd" / v.sig - 1) * 100 END,
    "simReturnPct" = v.sim
FROM v
WHERE co."id" = v."id"
  AND co."labelRule" = 2;

-- Rows still inside their windows: move the base to the alert price and let the watcher grade
-- them. A stop recorded against the fill that the alert price never reached is lifted, and a 2x
-- of the alert price already seen is stamped at the window's peak.
UPDATE "CandidateOutcome" co
SET "anchorPriceUsd" = co."signalPriceUsd",
    "labelRule" = 3,
    "stoppedAt" = CASE WHEN co."low1hPriceUsd" > 0.5 * co."signalPriceUsd" THEN NULL ELSE co."stoppedAt" END,
    "peakBeforeStopPriceUsd" = CASE
                                 WHEN co."stoppedAt" IS NOT NULL AND co."low1hPriceUsd" > 0.5 * co."signalPriceUsd"
                                   THEN co."peak1hPriceUsd"
                                 ELSE co."peakBeforeStopPriceUsd"
                               END,
    "hit2xAt" = CASE
                  WHEN co."hit2xAt" IS NULL AND co."peak1hPriceUsd" >= 2 * co."signalPriceUsd" THEN co."peak1hAt"
                  ELSE co."hit2xAt"
                END
WHERE co."labelRule" = 2
  AND co."finalizedAt" IS NULL
  AND co."finalized24hAt" IS NULL
  AND co."entryAt" IS NOT NULL
  AND co."signalPriceUsd" > 0;

-- Open rows that have not seen a price yet are already on the alert price.
UPDATE "CandidateOutcome"
SET "labelRule" = 3
WHERE "labelRule" = 2
  AND "finalizedAt" IS NULL
  AND "finalized24hAt" IS NULL
  AND "entryAt" IS NULL;

-- The feed's copies, so a card's badge and the training set agree.
UPDATE "CuratedAlert" a
SET "hit2xIn15m" = o."hit2xIn15m",
    "hit2xIn1h" = o."hit2xIn1h",
    "hit4xIn1h" = o."hit4xIn1h",
    "disqualified" = o."disqualified",
    "peak1hReturnPct" = o."peak1hReturnPct",
    "maxDrawdown1hPct" = o."maxDrawdown1hPct",
    "simReturnPct" = o."simReturnPct",
    "peak24hReturnPct" = COALESCE(o."peak24hReturnPct", a."peak24hReturnPct")
FROM "CandidateOutcome" o
WHERE a."candidateOutcomeId" = o."id"
  AND o."labelRule" = 3
  AND o."finalizedAt" IS NOT NULL
  AND (a."hit2xIn1h" IS DISTINCT FROM o."hit2xIn1h"
    OR a."hit2xIn15m" IS DISTINCT FROM o."hit2xIn15m"
    OR a."hit4xIn1h" IS DISTINCT FROM o."hit4xIn1h"
    OR a."disqualified" IS DISTINCT FROM o."disqualified"
    OR a."peak1hReturnPct" IS DISTINCT FROM o."peak1hReturnPct"
    OR a."maxDrawdown1hPct" IS DISTINCT FROM o."maxDrawdown1hPct"
    OR a."simReturnPct" IS DISTINCT FROM o."simReturnPct"
    OR (o."peak24hReturnPct" IS NOT NULL AND a."peak24hReturnPct" IS DISTINCT FROM o."peak24hReturnPct"));

-- User-filter alerts graded from a "match" row (reached through the indexed Match.tokenId).
UPDATE "Match" m
SET "hit2xIn1h" = o."hit2xIn1h",
    "hit4xIn1h" = o."hit4xIn1h",
    "disqualified" = o."disqualified",
    "peak1hReturnPct" = o."peak1hReturnPct",
    "maxDrawdown1hPct" = o."maxDrawdown1hPct"
FROM "CandidateOutcome" o
WHERE o."sampleKind" = 'match'
  AND o."labelRule" = 3
  AND o."finalizedAt" IS NOT NULL
  AND m."tokenId" = o."tokenId"
  AND m."candidateOutcomeId" = o."id"
  AND (m."hit2xIn1h" IS DISTINCT FROM o."hit2xIn1h"
    OR m."hit4xIn1h" IS DISTINCT FROM o."hit4xIn1h"
    OR m."disqualified" IS DISTINCT FROM o."disqualified"
    OR m."peak1hReturnPct" IS DISTINCT FROM o."peak1hReturnPct"
    OR m."maxDrawdown1hPct" IS DISTINCT FROM o."maxDrawdown1hPct");
