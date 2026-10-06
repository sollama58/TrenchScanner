-- A filter that ever ranked in the leaderboard's top KEEP_IF_EVER_RANKED_WITHIN (3) is kept when
-- its owner deletes it (retired: hidden from them, off, still on the board with its record) rather
-- than cascading its alert history away. bestRank is the best rank it ever held, written as the
-- board is built; deletedAt marks a retired filter. Nullable, no default: catalog-only. Safe to re-run.
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "bestRank" INTEGER;
ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
