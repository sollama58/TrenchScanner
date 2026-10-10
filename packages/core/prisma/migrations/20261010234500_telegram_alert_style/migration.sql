-- Telegram alerts: each chat's layout, link set and /alerts market cap floor (set with /settings).
-- Defaults keep every chat's alerts looking as they did. Safe to re-run.
ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "layout" TEXT NOT NULL DEFAULT 'full';
ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "links" TEXT[] NOT NULL DEFAULT ARRAY['terminal', 'axiom', 'gmgn']::TEXT[];
ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "alertsMinMcapUsd" DOUBLE PRECISION NOT NULL DEFAULT 5000;

-- "stats" was the whole numbers line and is now the market cap alone, with holders, volume and
-- age switched on their own: a chat that hid the numbers keeps all four hidden.
UPDATE "TelegramChat"
SET "hidden" = "hidden" || ARRAY(SELECT p FROM unnest(ARRAY['holders', 'volume', 'age']) AS p WHERE p <> ALL ("hidden"))
WHERE 'stats' = ANY ("hidden") AND NOT ("hidden" @> ARRAY['holders', 'volume', 'age']);
