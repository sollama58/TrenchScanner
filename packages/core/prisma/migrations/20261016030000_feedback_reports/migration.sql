-- Bug reports and suggestions (FeedbackReport in schema.prisma): a new, empty table. Safe to re-run.
CREATE TABLE IF NOT EXISTS "FeedbackReport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "contact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "walletAddress" TEXT,
    "submitterKey" TEXT NOT NULL,
    "context" JSONB,
    "screenshot" TEXT,
    "adminNote" TEXT,
    "handledBy" TEXT,

    CONSTRAINT "FeedbackReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FeedbackReport_createdAt_idx" ON "FeedbackReport"("createdAt");
CREATE INDEX IF NOT EXISTS "FeedbackReport_status_createdAt_idx" ON "FeedbackReport"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "FeedbackReport_submitterKey_createdAt_idx" ON "FeedbackReport"("submitterKey", "createdAt");
