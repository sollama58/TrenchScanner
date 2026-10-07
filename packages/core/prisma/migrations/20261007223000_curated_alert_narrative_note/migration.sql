-- The Narrative seat's note on a card another seat already called (agrees / warns), instead of a
-- second alert on the same coin.
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "narrativeVerdict" TEXT;
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "narrativeNotedAt" TIMESTAMP(3);
