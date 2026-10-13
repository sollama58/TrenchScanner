-- TokenSage rules 0.33.0+ trend novelty, and the 0.34.0+ decision-time refresh (fresh trend and
-- story heat, POST /v1/tokens:now). Null until read or refreshed; nothing is backfilled. Safe to
-- re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "trendNovelty" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "nowAt" TIMESTAMP(3);
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "nowTrendMatched" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "nowTrendScore" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "nowTrendNovelty" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatCoins" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatLeaderMcapUsd" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatLeaderChange5mPct" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatLeaderChange1hPct" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatLeaderVolume1hUsd" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatWaveVolume1hUsd" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatPeakMinutesAgo" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatFromPeakPct" DOUBLE PRECISION;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "heatIsLeader" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "nowRead" JSONB;
