-- ProTrade.scanned: an entry the hourly per-wallet scan cap let through; the worker's TokenSage
-- read follows these only (schema.prisma ProTrade). ProTrade is new and small: no lock concern.
ALTER TABLE "ProTrade" ADD COLUMN IF NOT EXISTS "scanned" BOOLEAN NOT NULL DEFAULT false;
