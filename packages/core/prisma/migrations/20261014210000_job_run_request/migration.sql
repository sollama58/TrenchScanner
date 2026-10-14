-- An admin's "Run now" for a scheduled worker job: the worker that owns the job picks up an
-- unstarted row and runs the job early. A new, empty table. Safe to re-run.
CREATE TABLE IF NOT EXISTS "JobRunRequest" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "JobRunRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobRunRequest_job_startedAt_idx" ON "JobRunRequest"("job", "startedAt");
