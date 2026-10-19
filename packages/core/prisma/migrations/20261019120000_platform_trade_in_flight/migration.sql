-- A Pro trade's in-flight state on its row, so any API instance can resend it after a deploy and
-- answer "expired" (apps/api/src/routes/proTrade.ts), and one send per build across instances.
-- Safe to re-run.
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "transaction" TEXT;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "lastValidBlockHeight" BIGINT;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "senderSpeed" TEXT;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "senderMevProtect" BOOLEAN;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "buildId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformTrade_buildId_key" ON "PlatformTrade"("buildId");
