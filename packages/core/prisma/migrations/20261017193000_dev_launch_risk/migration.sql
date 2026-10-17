-- The dev launch score (user ask 2026-10-17): each creator wallet's launch record and score, and
-- each funder's family of creators, rebuilt hourly by the trainer's devLaunchRiskJob.ts (core's
-- wallets/devLaunchScore.ts). New tables only; IF NOT EXISTS so a partly-applied run can be re-run.
CREATE TABLE IF NOT EXISTS "DevLaunchRisk" (
    "wallet" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "launches" INTEGER NOT NULL,
    "inBand" INTEGER NOT NULL,
    "graded" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "stops" INTEGER NOT NULL,
    "funder" TEXT,
    "lastLaunchAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevLaunchRisk_pkey" PRIMARY KEY ("wallet")
);

CREATE TABLE IF NOT EXISTS "DevFunderRisk" (
    "funder" TEXT NOT NULL,
    "creators" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "launches" INTEGER NOT NULL,
    "inBand" INTEGER NOT NULL,
    "graded" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "stops" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevFunderRisk_pkey" PRIMARY KEY ("funder")
);

CREATE INDEX IF NOT EXISTS "DevLaunchRisk_score_idx" ON "DevLaunchRisk"("score");
CREATE INDEX IF NOT EXISTS "DevLaunchRisk_funder_idx" ON "DevLaunchRisk"("funder");
CREATE INDEX IF NOT EXISTS "DevFunderRisk_score_idx" ON "DevFunderRisk"("score");
