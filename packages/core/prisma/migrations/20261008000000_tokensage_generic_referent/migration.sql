-- TokenSage rules 0.17.0 on the narrative cache: whether the referent is a kind only (generic)
-- and the lexicon version, so audits can split on it. Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "referentGeneric" BOOLEAN;
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "lexiconVersion" TEXT;
