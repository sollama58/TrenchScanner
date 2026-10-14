SET LOCAL lock_timeout = '5s';

-- Match(hitHundredPctAt, peakReturnPct) had 0 scans in production (db-size audit 2026-10-14, R5):
-- the Leaderboard, its only query on these columns, takes the best row per token with DISTINCT ON
-- (tokenId) and is answered by a sequential scan, cached for minutes. The index cost 18 MB and,
-- because peakReturnPct is in it, made every peak update of a match a non-HOT update that also
-- wrote all nine of Match's indexes. DROP INDEX holds an ACCESS EXCLUSIVE lock on Match for the
-- moment it takes; lock_timeout keeps it from queueing behind a long read.
DROP INDEX IF EXISTS "Match_hitHundredPctAt_peakReturnPct_idx";
