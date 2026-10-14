SET LOCAL lock_timeout = '5s';

-- Match rows older than MATCH_ARCHIVE_DAYS are moved here by the nightly cleanup (full audit
-- 2026-10-14 F11, user decision P21): Match was never pruned, and each row pinned its alert-time
-- snapshot and its Token. No foreign key to Token or TokenSnapshot, on purpose - see schema.prisma.
-- A new table, so nothing large is locked; the two foreign keys below briefly lock User and
-- UserFilter (SHARE ROW EXCLUSIVE, writes wait), so lock_timeout keeps them from queueing.
CREATE TABLE IF NOT EXISTS "MatchArchive" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "mintAddress" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "snapshotId" TEXT NOT NULL,
    "snapshotMarketCapUsd" DOUBLE PRECISION NOT NULL,
    "matchedAt" TIMESTAMP(3) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "deliveredDashboard" BOOLEAN NOT NULL,
    "peakMcapUsd" DOUBLE PRECISION,
    "peakMcapAt" TIMESTAMP(3),
    "alertMcapUsd" DOUBLE PRECISION,
    "peakReturnPct" DOUBLE PRECISION,
    "hitHundredPctAt" TIMESTAMP(3),
    "candidateOutcomeId" TEXT,
    "peak1hReturnPct" DOUBLE PRECISION,
    "maxDrawdown1hPct" DOUBLE PRECISION,
    "hit2xIn1h" BOOLEAN,
    "hit4xIn1h" BOOLEAN,
    "hit10xIn1h" BOOLEAN,
    "disqualified" BOOLEAN,
    "peak24hReturnPct" DOUBLE PRECISION,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchArchive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MatchArchive_userId_matchedAt_idx" ON "MatchArchive"("userId", "matchedAt");
CREATE INDEX IF NOT EXISTS "MatchArchive_filterId_idx" ON "MatchArchive"("filterId");
CREATE INDEX IF NOT EXISTS "MatchArchive_matchedAt_idx" ON "MatchArchive"("matchedAt");
CREATE INDEX IF NOT EXISTS "MatchArchive_tokenId_idx" ON "MatchArchive"("tokenId");

-- Deleting a user or a filter deletes its archived matches too, as it does its live ones.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchArchive_userId_fkey') THEN
    ALTER TABLE "MatchArchive" ADD CONSTRAINT "MatchArchive_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchArchive_filterId_fkey') THEN
    ALTER TABLE "MatchArchive" ADD CONSTRAINT "MatchArchive_filterId_fkey"
      FOREIGN KEY ("filterId") REFERENCES "UserFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
