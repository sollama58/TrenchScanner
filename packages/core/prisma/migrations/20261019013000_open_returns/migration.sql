-- Current returns for calls still riding their trailing share (user ask 2026-10-19): the watcher's
-- running value, and the Lighthouse rollup's count of such rows in each hour's return sums.
-- A nullable column and two with constant defaults: catalog-only changes, no table rewrite.
-- Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "openReturnPct" DOUBLE PRECISION;
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "screenedReturnOpen" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "alertsReturnOpen" INTEGER NOT NULL DEFAULT 0;
