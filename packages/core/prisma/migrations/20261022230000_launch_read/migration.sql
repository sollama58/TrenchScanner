-- Launch reads kept across restarts (worker launchReadStore.ts), and block zero (user ask 2026-10-22):
-- the % of supply its wallets hold on each scan, how many there were and what they bought, and the
-- filter ceiling on the held share.
CREATE TABLE IF NOT EXISTS "LaunchRead" (
    "mintAddress" TEXT NOT NULL,
    "reading" JSONB NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LaunchRead_pkey" PRIMARY KEY ("mintAddress")
);
CREATE INDEX IF NOT EXISTS "LaunchRead_checkedAt_idx" ON "LaunchRead"("checkedAt");

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "blockZeroHeldPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "blockZeroBuyers" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "blockZeroBoughtPct" DOUBLE PRECISION;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxBlockZeroHeldPct" DOUBLE PRECISION;
