-- TelegramChat remembers when it was last told that no alert had reached it in a week
-- (telegram/dispatch.ts IDLE_CHAT_MS; audit 2026-11-02 WB-45, user decision "one notice a week").
-- A small table read by every dispatch pass, so the ALTER gives up rather than queue behind a long
-- read (scripts/migrate-deploy.sh retries). Nullable, no default; re-runnable.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TelegramChat" ADD COLUMN IF NOT EXISTS "idleNoticedAt" TIMESTAMP(3);
