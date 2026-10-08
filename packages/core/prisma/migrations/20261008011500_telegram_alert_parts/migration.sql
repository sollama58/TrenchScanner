-- Telegram alerts: which parts of the card a chat has switched off. Safe to re-run.
ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "hidden" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
