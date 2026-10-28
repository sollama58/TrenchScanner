-- Web Push sends, one row per alert a notification carried (audit 2026-10-27 GF-10): the push
-- side of the funnel's last stage, exported as /stats/export dataset push-sent. A new empty
-- table, no lock on anything live. Safe to re-run.
CREATE TABLE IF NOT EXISTS "WebPushAlertSent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "curatedAlertId" TEXT,
    "matchId" TEXT,
    "batched" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebPushAlertSent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebPushAlertSent_sentAt_idx" ON "WebPushAlertSent"("sentAt");
