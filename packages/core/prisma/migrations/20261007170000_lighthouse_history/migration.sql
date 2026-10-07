-- The Market Lighthouse's history: hourly sums and daily label breakdowns the rollup job writes
-- and nothing deletes, so trends outlive the rows they are summed from. Safe to re-run.
CREATE TABLE IF NOT EXISTS "LighthouseHour" (
    "hour" TIMESTAMP(3) NOT NULL,
    "screenedCalls" INTEGER NOT NULL DEFAULT 0,
    "screenedGraded" INTEGER NOT NULL DEFAULT 0,
    "screenedWon2x" INTEGER NOT NULL DEFAULT 0,
    "screenedWon4x" INTEGER NOT NULL DEFAULT 0,
    "screenedWon10x" INTEGER NOT NULL DEFAULT 0,
    "screenedTenXGraded" INTEGER NOT NULL DEFAULT 0,
    "screenedReturnN" INTEGER NOT NULL DEFAULT 0,
    "screenedReturnSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "readsTotal" INTEGER NOT NULL DEFAULT 0,
    "readsDescribed" INTEGER NOT NULL DEFAULT 0,
    "readsDeep" INTEGER NOT NULL DEFAULT 0,
    "readsFailed" INTEGER NOT NULL DEFAULT 0,
    "referentConfidenceSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "referentConfidenceN" INTEGER NOT NULL DEFAULT 0,
    "xFitSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "xFitN" INTEGER NOT NULL DEFAULT 0,
    "copiesRecent" INTEGER NOT NULL DEFAULT 0,
    "copiesAnswered" INTEGER NOT NULL DEFAULT 0,
    "trendMatched" INTEGER NOT NULL DEFAULT 0,
    "trendAnswered" INTEGER NOT NULL DEFAULT 0,
    "alerts" INTEGER NOT NULL DEFAULT 0,
    "alertsDescribed" INTEGER NOT NULL DEFAULT 0,
    "alertsGraded" INTEGER NOT NULL DEFAULT 0,
    "alertsWon2x" INTEGER NOT NULL DEFAULT 0,
    "alertsWon4x" INTEGER NOT NULL DEFAULT 0,
    "alertsWon10x" INTEGER NOT NULL DEFAULT 0,
    "alertsReturnN" INTEGER NOT NULL DEFAULT 0,
    "alertsReturnSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LighthouseHour_pkey" PRIMARY KEY ("hour")
);

CREATE TABLE IF NOT EXISTS "LighthouseDayLabel" (
    "day" TIMESTAMP(3) NOT NULL,
    "dimension" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "alerts" INTEGER NOT NULL DEFAULT 0,
    "graded" INTEGER NOT NULL DEFAULT 0,
    "won2x" INTEGER NOT NULL DEFAULT 0,
    "won4x" INTEGER NOT NULL DEFAULT 0,
    "won10x" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LighthouseDayLabel_pkey" PRIMARY KEY ("day","dimension","label")
);
