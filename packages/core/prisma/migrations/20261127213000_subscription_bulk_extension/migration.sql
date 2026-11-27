-- The Admin panel's "extend every subscription" (user ask 2026-11-27): one row per run, keyed by
-- the panel's request id so a retried request can't add the time twice. A new table; safe to re-run.
CREATE TABLE IF NOT EXISTS "SubscriptionBulkExtension" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,
    "deviceId" TEXT,
    "unit" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "usersExtended" INTEGER NOT NULL,

    CONSTRAINT "SubscriptionBulkExtension_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionBulkExtension_requestId_key" ON "SubscriptionBulkExtension"("requestId");
CREATE INDEX IF NOT EXISTS "SubscriptionBulkExtension_at_idx" ON "SubscriptionBulkExtension"("at");
