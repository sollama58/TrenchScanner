-- Nullable column with no default: a catalog-only change. IF NOT EXISTS so a re-run is a no-op.
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "devHolding" BOOLEAN;
