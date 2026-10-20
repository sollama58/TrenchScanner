-- TokenSage rules 0.36.0: the post a basic (or full) read took its referent from.
-- Kept on the row so a basic read stored without its document still has the wave key.
--
-- TokenNarrative is written on every narrative store. The ALTER waits only five seconds
-- for its lock, then migrate-deploy retries, so a long read cannot stall the table.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "referentPostId" TEXT;
