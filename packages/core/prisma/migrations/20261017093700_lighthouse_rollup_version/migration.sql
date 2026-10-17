-- Which summing rules each LighthouseHour row was last summed under (apps/worker's
-- lighthouseRollupJob.ts LIGHTHOUSE_ROLLUP_VERSION). Every existing row reads 0, so the rollup
-- re-sums the stored history's screened counts once, in batches, under the current rules (the
-- labelRule >= REPORTED_LABEL_RULE filter, 2026-10-17). LighthouseHour is one row an hour, so the
-- default is cheap; IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "rollupVersion" INTEGER NOT NULL DEFAULT 0;
