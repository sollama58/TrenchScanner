-- The filter leaderboard scores run size like the models do (PR #147), so each filter alert keeps
-- its anchor's run peak (Match.peak24hReturnPct), copied when the anchor retires. A nullable column
-- with no default: a catalog-only change, no rewrite of Match. Safe to re-run.
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "peak24hReturnPct" DOUBLE PRECISION;
