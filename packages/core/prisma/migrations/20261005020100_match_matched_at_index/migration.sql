-- The peak passes pick matches inside the snapshot retention window by matchedAt alone (the
-- existing (userId, matchedAt) index can't serve that), scanning all of Match. Built the same way
-- as 20261005020000_match_peak_at_index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Match_matchedAt_idx" ON "Match"("matchedAt");
