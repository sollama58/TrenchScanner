-- Per-coin profit or loss on each wallet's risk row, median and mean, in SOL and % (WalletModal).
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "pnlCoins" INTEGER;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "medianPnlSol" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "avgPnlSol" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "medianPnlPct" DOUBLE PRECISION;
ALTER TABLE "WalletRisk" ADD COLUMN IF NOT EXISTS "avgPnlPct" DOUBLE PRECISION;
