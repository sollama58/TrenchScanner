-- CandidateOutcome's (tokenId, anchorAt) index was a strict prefix-equivalent of
-- (tokenId, sampleKind, anchorAt): every query that filters a token by anchor time also names the
-- sample kind, and plain per-token probes (cleanup's NOT EXISTS, the FK) use the wider index's
-- prefix. One fewer btree to maintain on the most-written training table. CONCURRENTLY, alone in
-- its file, so the drop takes no lock the watcher's writes queue behind; IF EXISTS makes a re-run
-- a no-op.
DROP INDEX CONCURRENTLY IF EXISTS "CandidateOutcome_tokenId_anchorAt_idx";
