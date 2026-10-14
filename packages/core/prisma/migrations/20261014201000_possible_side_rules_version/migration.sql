-- The label rules each possible-side label was earned under (user ask 2026-10-14: labels from the
-- old cutoffs were still held). Existing rows take 0, so the next hourly run drops them and relabels
-- only wallets that meet the current rules. A constant default is a catalog-only change on this
-- small table; the lock timeout keeps the ALTER from queueing (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "KolPossibleSide" ADD COLUMN IF NOT EXISTS "rulesVersion" INTEGER NOT NULL DEFAULT 0;
