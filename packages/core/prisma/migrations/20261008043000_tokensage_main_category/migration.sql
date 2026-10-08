-- TokenSage rules 0.20.0 on the narrative cache: the coin's main category (main_category.label),
-- so a copy reads under its theme rather than "derivative". Safe to re-run.
ALTER TABLE "TokenNarrative" ADD COLUMN IF NOT EXISTS "mainCategory" TEXT;
