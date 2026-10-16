-- Bubble maps kept at the first safety-screen pass and at a user's first opened filter catch
-- (BubbleMapMoment, user ask 2026-10-16), beside the one at the first model call. A new table, so
-- nothing is locked. IF NOT EXISTS so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "BubbleMapMoment" (
    "id" TEXT NOT NULL,
    "mintAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT '',
    "filterId" TEXT,
    "isPublic" BOOLEAN NOT NULL,
    "momentAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "reading" TEXT,
    "sameAsId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BubbleMapMoment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BubbleMapMoment_mintAddress_kind_userId_key" ON "BubbleMapMoment"("mintAddress", "kind", "userId");
CREATE INDEX IF NOT EXISTS "BubbleMapMoment_createdAt_idx" ON "BubbleMapMoment"("createdAt");
