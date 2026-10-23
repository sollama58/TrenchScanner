-- Social links from more than Pump.fun (user bug report 2026-10-23): the coin's Telegram link,
-- kept like its X and website links, and when the socials fill last asked for a coin's links
-- (apps/worker/src/jobs/socialsFill.ts). Nullable columns with no default are catalog-only
-- changes; the lock timeout keeps the Token ALTER queued behind a long read from stalling the
-- scanner. IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "telegramUrl" TEXT;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "socialsCheckedAt" TIMESTAMP(3);
