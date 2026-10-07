-- TokenSage narrative criteria on saved filters. Safe to re-run.
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "narrativeCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "excludeNarrativeCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "excludeCopycats" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "excludeNarrativeRedFlags" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "excludeUnrelatedX" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "requireTrendMatch" BOOLEAN NOT NULL DEFAULT false;
