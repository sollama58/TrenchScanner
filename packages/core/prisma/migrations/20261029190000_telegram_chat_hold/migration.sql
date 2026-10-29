-- How long Telegram told the bot to stop sending to a chat (a 429's retry_after), kept on the row
-- so the worker's dispatcher and the API's command and Refresh replies both wait it out, and a
-- restart doesn't forget it (Telegram supergroup evening stalls, check-in 2026-10-29). A nullable
-- column with no default rewrites nothing. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "holdUntil" TIMESTAMP(3);
