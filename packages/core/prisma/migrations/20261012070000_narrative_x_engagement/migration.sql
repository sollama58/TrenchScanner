-- TokenSage rules 0.30.0+: the linked X post's engagement counts, when they were counted, and when
-- the post went up. Null on older reads; nothing is backfilled. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xLikes" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xReposts" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xReplies" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xViews" INTEGER;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xEngagementAt" TIMESTAMP(3);
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "xPostedAt" TIMESTAMP(3);
