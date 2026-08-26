-- CreateTable
CREATE TABLE "SystemHeartbeat" (
    "job" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "meta" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("job")
);
