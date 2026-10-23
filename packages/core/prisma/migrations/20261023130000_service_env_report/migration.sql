-- Admin > Environment (user ask 2026-10-23): each worker process's report of which expected env vars
-- it has set, written at boot (packages/core/src/config/envReport.ts).
CREATE TABLE IF NOT EXISTS "ServiceEnvReport" (
    "service" TEXT NOT NULL,
    "vars" JSONB NOT NULL,
    "commit" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceEnvReport_pkey" PRIMARY KEY ("service")
);
