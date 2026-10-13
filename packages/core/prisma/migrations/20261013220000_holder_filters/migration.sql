-- Two opt-in filter criteria on the holder data (notes/holder-data-eval-2026-10-13): a ceiling on
-- the supply held by holders tied to the creator, and a floor on Jupiter's live holder count.
-- Nullable columns with no default are catalog-only changes. IF NOT EXISTS so a partly-applied
-- run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxLinkedCreatorPct" DOUBLE PRECISION;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "minLiveHolderCount" INTEGER;
