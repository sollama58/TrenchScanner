-- Every seat's probability at each decision moment, so the high-conviction line can be the top
-- slice of a seat's last 24 hours of live scores (model audit 2026-10-14: the line drawn on the
-- training rows sat above every live score and the tier went silent). A nullable column with no
-- default is a catalog-only change, with no backfill; the lock timeout keeps the ALTER from
-- queueing behind a long read on this busy table (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "seatScores" JSONB;
