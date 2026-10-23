-- Peaks parked by mistake (API audit 2026-10-23): the Peaks job wrote noCandles = true, "not a
-- Pump.fun coin", whenever its candle reader answered null, and since Pump.fun's 403s (2026-10-22)
-- the reader also answered null when no source could say (Pump.fun paused, the candle store empty,
-- no CoinGecko key). The job now retries those; this gives the coins it parked their reads back.
-- Idempotent: a second run finds nothing to update.
UPDATE "PeakWatch"
SET "noCandles" = false, "nextCheckAt" = NOW()
WHERE "noCandles" = true AND "lastCheckedAt" >= TIMESTAMP '2026-10-22 00:00:00';
