-- One verdict per playbook per graded alert in a replay run (audit 2026-10-27 AJ-14). In the
-- seconds between a lost lock connection and the abort, an ingest could write beside another
-- process's re-ingest of the same batch, and summarizeRun counted the copies twice. The ingest
-- now writes with skipDuplicates against this key (worker ai/replay.ts). Duplicates already there
-- are removed first, keeping one of each (copies of one batch result, so identical verdicts).
-- The table is small and written only by the nightly replay ingest. Safe to re-run.
SET LOCAL lock_timeout = '5s';
DELETE FROM "AiReplayVerdict" a
USING "AiReplayVerdict" b
WHERE a."runId" = b."runId"
  AND a."playbookId" = b."playbookId"
  AND a."candidateOutcomeId" = b."candidateOutcomeId"
  AND a."id" > b."id";
CREATE UNIQUE INDEX IF NOT EXISTS "AiReplayVerdict_runId_playbookId_candidateOutcomeId_key"
  ON "AiReplayVerdict"("runId", "playbookId", "candidateOutcomeId");
