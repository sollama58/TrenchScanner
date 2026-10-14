-- The span a possible side wallet's match was read over (24, 36 or 48 hours). A column with a
-- constant default, so nothing is rewritten.
ALTER TABLE "KolPossibleSide" ADD COLUMN IF NOT EXISTS "hours" INTEGER NOT NULL DEFAULT 24;
