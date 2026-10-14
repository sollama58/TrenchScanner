-- KOL Bundled % (user ask 2026-10-14): supply held by KOLs and the top holders tied to them, on
-- each snapshot, and a ceiling on it as a filter criterion. Nullable columns with no default are
-- catalog-only changes. IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "kolBundledPct" DOUBLE PRECISION;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxKolBundledPct" DOUBLE PRECISION;
