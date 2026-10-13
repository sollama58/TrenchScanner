-- Outside API call counts for the admin panel's API usage section (core's apiUsage.ts).
-- A new table only; IF NOT EXISTS throughout so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "ApiUsage" (
    "bucket" TIMESTAMP(3) NOT NULL,
    "process" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "rateLimited" INTEGER NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "msTotal" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("bucket","process","provider","endpoint","feature")
);
CREATE INDEX IF NOT EXISTS "ApiUsage_bucket_idx" ON "ApiUsage"("bucket");
