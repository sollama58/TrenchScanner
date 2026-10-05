-- Simulated profit under the fixed exit plan (curation/profitSim.ts). Safe to re-run: IF NOT EXISTS
-- on the columns, and the backfill only touches rows still null.
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "simReturnPct" DOUBLE PRECISION;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "simReturnPct" DOUBLE PRECISION;

-- One-off backfill for the calls already graded, under the default plan as it ships: half at 2x,
-- the rest at 4x, stop at -50%, close at 1 hour, every sale paying the venue's default slippage
-- (1% graduated, 3% pre-bond). Only rows a curated alert points at (the leaderboard and the
-- Admin panel read nothing else), graded from a fill (labelRule 2). The close is the last price
-- the watcher saw, which is the 1-hour price only on rows it stopped watching at the hour; rows on
-- the 24h watch whose plan still held a share at the hour are left null rather than guessed.
WITH sim AS (
  SELECT co."id",
         co."anchorPriceUsd" AS entry,
         COALESCE(co."peakBeforeStopPriceUsd", co."peak1hPriceUsd") AS peak,
         CASE WHEN co."peakBeforeStopPriceUsd" IS NOT NULL THEN co."stoppedAt" IS NOT NULL
              ELSE co."low1hPriceUsd" <= co."anchorPriceUsd" * 0.5 END AS stopped,
         CASE WHEN co."extended24h" THEN NULL ELSE co."lastPriceUsd" END AS close,
         CASE WHEN (co."features"->>'graduated') = '1' THEN 0.01 ELSE 0.03 END AS slip
  FROM "CandidateOutcome" co
  WHERE co."simReturnPct" IS NULL
    AND co."finalizedAt" IS NOT NULL
    AND co."entryAt" IS NOT NULL
    AND co."labelRule" = 2
    AND co."anchorPriceUsd" > 0
    AND EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."candidateOutcomeId" = co."id")
),
valued AS (
  SELECT "id", slip,
         CASE
           WHEN peak >= entry * 4 THEN 0.5 * 2 + 0.5 * 4
           WHEN peak >= entry * 2 THEN 0.5 * 2 + 0.5 * (CASE WHEN stopped THEN 0.5 ELSE close / entry END)
           ELSE (CASE WHEN stopped THEN 0.5 ELSE close / entry END)
         END AS proceeds
  FROM sim
)
UPDATE "CandidateOutcome" co
SET "simReturnPct" = (v.proceeds * (1 - v.slip) - 1) * 100
FROM valued v
WHERE co."id" = v."id" AND v.proceeds IS NOT NULL;

UPDATE "CuratedAlert" a
SET "simReturnPct" = co."simReturnPct"
FROM "CandidateOutcome" co
WHERE co."id" = a."candidateOutcomeId"
  AND a."simReturnPct" IS NULL
  AND co."simReturnPct" IS NOT NULL;
