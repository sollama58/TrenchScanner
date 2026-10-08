-- A model call's market-cap high since the call, kept like Match.peakMcapUsd so its Peak never
-- walks back when the live reading falls. Nullable, no default: instant on Postgres. Safe to re-run.
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "peakMcapUsd" DOUBLE PRECISION;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "peakMcapAt" TIMESTAMP(3);
