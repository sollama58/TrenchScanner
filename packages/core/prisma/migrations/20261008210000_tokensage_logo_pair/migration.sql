-- TokenSage rules 0.25.0 and 0.27.0 on the narrative cache: the logo's best visual class and its
-- score (image.labels[0], full reads), and whether the pair token is itself a pump.fun coin
-- (market.pair.pumpfun). Null on older reads. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "pairPumpfun" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "logoLabel" TEXT;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "logoScore" DOUBLE PRECISION;
