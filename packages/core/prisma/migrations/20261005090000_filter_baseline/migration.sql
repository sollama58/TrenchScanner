-- A newly created, activated or edited filter no longer alerts on every token that already
-- matches it (see UserFilter.armedAt and FilterBaseline in schema.prisma). Safe to re-run.
--
-- Existing filters get the migration time as armedAt: for the first couple of minutes after the
-- deploy they only record what already matches, which is the backlog they had already alerted.

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "armedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "FilterBaseline" (
    "filterId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilterBaseline_pkey" PRIMARY KEY ("filterId","tokenId")
);

CREATE INDEX IF NOT EXISTS "FilterBaseline_createdAt_idx" ON "FilterBaseline"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FilterBaseline_filterId_fkey') THEN
    ALTER TABLE "FilterBaseline" ADD CONSTRAINT "FilterBaseline_filterId_fkey"
      FOREIGN KEY ("filterId") REFERENCES "UserFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
