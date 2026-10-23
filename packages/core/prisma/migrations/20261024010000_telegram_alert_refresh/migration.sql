-- Telegram alert Refresh button (user ask 2026-10-23): the card each single alert was sent with,
-- so a press can rebuild it with fresh numbers, and when it was last refreshed, for the 15-second
-- cooldown. Two nullable columns, no rewrite. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TelegramAlertSent" ADD COLUMN IF NOT EXISTS "card" JSONB;
ALTER TABLE "TelegramAlertSent" ADD COLUMN IF NOT EXISTS "refreshedAt" TIMESTAMP(3);
