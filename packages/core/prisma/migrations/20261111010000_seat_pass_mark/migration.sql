-- The pass mark for calling live (2026-11-11, user decision on MT-2 of the 2026-10-27 audit):
-- each decision moment's would-be calls, and one verdict row per seat. The CandidateOutcome
-- column is nullable with no default, so no row is rewritten; the table is new. Safe to re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CandidateOutcome" ADD COLUMN IF NOT EXISTS "seatCalls" JSONB;

CREATE TABLE IF NOT EXISTS "CuratorPassMark" (
    "contestant" TEXT NOT NULL,
    "calling" BOOLEAN NOT NULL,
    "graded" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "marketGraded" INTEGER NOT NULL,
    "marketWins" INTEGER NOT NULL,
    "liveLiftLower" DOUBLE PRECISION,
    "examLift" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "judgedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuratorPassMark_pkey" PRIMARY KEY ("contestant")
);
