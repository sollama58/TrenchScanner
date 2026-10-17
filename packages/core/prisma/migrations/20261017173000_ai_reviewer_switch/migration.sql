-- The Admin panel's AI reviewer switch (core's curation/aiSwitch.ts): one row, read by the worker
-- before any Claude call. A new, empty table; no row reads as "off". IF NOT EXISTS so a
-- partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "AiReviewerSwitch" (
    "id" TEXT NOT NULL DEFAULT 'ai-reviewer',
    "state" TEXT NOT NULL DEFAULT 'off',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiReviewerSwitch_pkey" PRIMARY KEY ("id")
);
