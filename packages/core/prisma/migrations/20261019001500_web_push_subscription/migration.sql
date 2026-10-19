-- Web Push subscriptions: alerts as push notifications with the app closed (webPush/dispatch.ts).
-- A new table only; the lock timeout keeps the foreign key from stalling behind a long read on
-- "User" (scripts/migrate-deploy.sh retries it).
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "sentThrough" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentTokens" JSONB NOT NULL DEFAULT '{}',
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "WebPushSubscription_userId_idx" ON "WebPushSubscription"("userId");
DO $$ BEGIN
  ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
