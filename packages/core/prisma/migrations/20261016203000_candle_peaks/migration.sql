-- Peak/ATH from the coin's own trades (worker jobs/candlePeaks.ts, user ask 2026-10-16). Nullable
-- columns with no default are catalog-only changes; the lock timeout keeps an ALTER queued behind a
-- long read from stalling the scanner (scripts/migrate-deploy.sh retries it). IF NOT EXISTS so a
-- partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "peakCheckedAt" TIMESTAMP(3);
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "peakCheckedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PeakWatch" (
    "tokenId" TEXT NOT NULL,
    "firstAlertAt" TIMESTAMP(3) NOT NULL,
    "lastAlertAt" TIMESTAMP(3) NOT NULL,
    "nextCheckAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "candlesTrusted" BOOLEAN,
    "athMcapUsd" DOUBLE PRECISION,
    "athAt" TIMESTAMP(3),
    "noCandles" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PeakWatch_pkey" PRIMARY KEY ("tokenId")
);

CREATE INDEX IF NOT EXISTS "PeakWatch_nextCheckAt_idx" ON "PeakWatch"("nextCheckAt");

DO $$ BEGIN
  ALTER TABLE "PeakWatch" ADD CONSTRAINT "PeakWatch_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
