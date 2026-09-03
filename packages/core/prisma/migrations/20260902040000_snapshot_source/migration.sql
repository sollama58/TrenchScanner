-- Records which job wrote a snapshot: the full scan cycle ("scan") or the 15-second fast match
-- pass ("fast").
--
-- The fast pass carries a token's on-chain profile forward from the last scan instead of
-- re-resolving it, so its rows restate a rug-screen verdict rather than establishing one. The
-- pass's own candidate query asks "which tokens were vetted recently", and while that was
-- answered from every snapshot, each fast row re-armed the window - a token whose newer scan
-- verdict had flipped to failing stayed alertable indefinitely off its own restatements.
--
-- Existing rows default to "scan": they predate the fast pass's lazy writes being distinguishable,
-- and the overwhelming majority were written by the full cycle. Treating them as vetting matches
-- the behaviour those rows were created under.
ALTER TABLE "TokenSnapshot" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'scan';

-- Serves the fast pass's candidate query (newest scan row per token inside the vetting window).
CREATE INDEX "TokenSnapshot_source_takenAt_idx" ON "TokenSnapshot"("source", "takenAt");
