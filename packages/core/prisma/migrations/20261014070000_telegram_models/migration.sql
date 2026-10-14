-- Telegram alerts can carry a different set of models than the Live Feed. Every existing user
-- starts on "same as Live Feed", so nothing they receive changes until they pick otherwise.
-- User is read on every request, so the ALTERs give up rather than queue behind a long read
-- (scripts/migrate-deploy.sh retries). Constant defaults, so the ADD COLUMNs are metadata-only
-- (no table rewrite); re-runnable.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramSameAsFeed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramModels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
