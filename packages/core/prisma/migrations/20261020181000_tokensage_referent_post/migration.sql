-- TokenSage rules 0.36.0: the post a basic (or full) read took its referent from.
-- Kept on the row so a basic read stored without its document still has the wave key.
ALTER TABLE "TokenNarrative" ADD COLUMN "referentPostId" TEXT;
