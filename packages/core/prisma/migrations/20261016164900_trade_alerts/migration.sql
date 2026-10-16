-- Which trade notes reach a user's Telegram chats (trading/tradeAlerts.ts). Null = all of them.
-- A nullable column with no default is a catalog-only change; the lock timeout keeps it from
-- stalling sign-ins behind a long read (scripts/migrate-deploy.sh retries it). Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tradeAlerts" JSONB;
