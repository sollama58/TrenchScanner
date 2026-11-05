-- Alert webhooks for outside partners (2026-11-05, first outside stats user): the webhook each
-- partner sets with its own STATS_PARTNER_TOKENS token, and the deliveries the worker's
-- webhook-dispatch job owes it. New tables, so nothing is locked; re-runnable.
CREATE TABLE IF NOT EXISTS "PartnerWebhook" (
    "id" TEXT NOT NULL,
    "partner" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pausedReason" TEXT,
    "sentThrough" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhook_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PartnerWebhook_partner_key" ON "PartnerWebhook"("partner");

CREATE TABLE IF NOT EXISTS "PartnerWebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "curatedAlertId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "PartnerWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PartnerWebhookDelivery_webhookId_curatedAlertId_key" ON "PartnerWebhookDelivery"("webhookId", "curatedAlertId");
CREATE INDEX IF NOT EXISTS "PartnerWebhookDelivery_status_nextAttemptAt_idx" ON "PartnerWebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "PartnerWebhookDelivery_webhookId_createdAt_idx" ON "PartnerWebhookDelivery"("webhookId", "createdAt");
CREATE INDEX IF NOT EXISTS "PartnerWebhookDelivery_createdAt_idx" ON "PartnerWebhookDelivery"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PartnerWebhookDelivery_webhookId_fkey') THEN
    ALTER TABLE "PartnerWebhookDelivery" ADD CONSTRAINT "PartnerWebhookDelivery_webhookId_fkey"
      FOREIGN KEY ("webhookId") REFERENCES "PartnerWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
