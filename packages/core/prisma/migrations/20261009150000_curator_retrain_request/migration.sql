-- An admin's "retrain now": the trainer picks up an unstarted row and runs curator training at
-- once. Safe to re-run.
CREATE TABLE IF NOT EXISTS "CuratorRetrainRequest" (
    "id" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "CuratorRetrainRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CuratorRetrainRequest_startedAt_idx" ON "CuratorRetrainRequest"("startedAt");
