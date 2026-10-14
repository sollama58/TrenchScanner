-- Telegram sends are claimed before they go out (2026-10-14): a row keyed by chat, token and the
-- alert it carries is written first, and a second claim of the same key does nothing, so a pass
-- that runs twice, or a send whose answer was lost and was retried, can't repeat an alert. The
-- table is small (a week of sends per linked chat). Re-runnable.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TelegramAlertSent" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramAlertSent_dedupeKey_key" ON "TelegramAlertSent"("dedupeKey");
