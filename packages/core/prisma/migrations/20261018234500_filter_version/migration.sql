-- Earlier versions of a filter's criteria, written when they change, so the filter leaderboard can
-- keep each version's record as its own entry (user decision 2026-10-18). A new empty table: no
-- backfill (criteria replaced before this were not kept) and no lock on existing rows. Safe to re-run.
CREATE TABLE IF NOT EXISTS "FilterVersion" (
    "id" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "criteria" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "bestRank" INTEGER,

    CONSTRAINT "FilterVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FilterVersion_filterId_version_key" ON "FilterVersion"("filterId", "version");

DO $$ BEGIN
  ALTER TABLE "FilterVersion" ADD CONSTRAINT "FilterVersion_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "UserFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
