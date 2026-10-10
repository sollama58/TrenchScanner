-- The tokens each Telegram chat has already been alerted about, so a second model's call on the
-- same coin isn't sent again. Safe to re-run.
CREATE TABLE IF NOT EXISTS "TelegramAlertSent" (
    "chatId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramAlertSent_pkey" PRIMARY KEY ("chatId","tokenId")
);

CREATE INDEX IF NOT EXISTS "TelegramAlertSent_sentAt_idx" ON "TelegramAlertSent"("sentAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TelegramAlertSent_chatId_fkey') THEN
    ALTER TABLE "TelegramAlertSent" ADD CONSTRAINT "TelegramAlertSent_chatId_fkey"
      FOREIGN KEY ("chatId") REFERENCES "TelegramChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
