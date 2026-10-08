-- Nullable, no default: catalog-only. IF NOT EXISTS so a partly-applied run can be re-run.
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "narrativeRationale" JSONB;
