-- Telegram boards grade the call a chat was actually sent, and a re-alert is a send of its own
-- (audit P18, 2026-10-14): TelegramAlertSent keeps one row per send, keyed by its time too, with
-- the call or match the alert carried. TelegramChat remembers when it was told its Telegram picks
-- fell back to the top models, and User whether Telegram gets the high-conviction tier only
-- (audit P10). BurnScanCursor can step over a transaction the RPC never returns
-- (audit S2). Small tables (a few rows per linked chat, one cursor row), but TelegramChat is read
-- by every dispatch pass, so the ALTERs give up rather than queue behind a long read
-- (scripts/migrate-deploy.sh retries). Constant defaults only; re-runnable.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TelegramAlertSent" ADD COLUMN IF NOT EXISTS "curatedAlertId" TEXT;
ALTER TABLE "TelegramAlertSent" ADD COLUMN IF NOT EXISTS "matchId" TEXT;
-- The key gains sentAt, so a token can be sent to a chat more than once. Swapped only while the
-- old two-column key is still in place.
DO $$
BEGIN
  IF (
    SELECT count(*) FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'TelegramAlertSent_pkey' AND i.indnatts = 2
  ) > 0 THEN
    ALTER TABLE "TelegramAlertSent" DROP CONSTRAINT "TelegramAlertSent_pkey";
    ALTER TABLE "TelegramAlertSent" ADD CONSTRAINT "TelegramAlertSent_pkey" PRIMARY KEY ("chatId", "tokenId", "sentAt");
  END IF;
END $$;

ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "picksFallbackNoticedAt" TIMESTAMP(3);

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramHighConvictionOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BurnScanCursor" ADD COLUMN IF NOT EXISTS "stuckSignature" TEXT;
ALTER TABLE "BurnScanCursor" ADD COLUMN IF NOT EXISTS "stuckPasses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BurnScanCursor" ADD COLUMN IF NOT EXISTS "skippedSignatures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
