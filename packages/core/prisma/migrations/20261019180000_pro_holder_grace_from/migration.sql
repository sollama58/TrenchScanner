-- When a top holder's grace period started (packages/core/src/subscription/proHolders.ts): the
-- first fresh scan after a holder-scan outage rather than the last scan before it, so an outage
-- doesn't use up the grace. Null on existing rows: their grace runs from lastInTopAt as before.
-- Safe to re-run.
ALTER TABLE "ProHolder" ADD COLUMN IF NOT EXISTS "graceFrom" TIMESTAMP(3);
