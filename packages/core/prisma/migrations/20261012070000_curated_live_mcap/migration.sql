SET LOCAL lock_timeout = '5s';
-- The market cap Pump.fun reported for the coin as the call went out (see the worker's
-- liveMarketCaps). DexScreener's price, which the anchor keeps, runs 45-60s behind the market.
-- Null when Pump.fun didn't answer in time. Display only: grades still start from the anchor.
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "liveMcapUsd" DOUBLE PRECISION;
