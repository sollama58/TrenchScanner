-- CreateTable
CREATE TABLE "CuratorModel" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "trainingRows" INTEGER NOT NULL,
    "trainingFrom" TIMESTAMP(3) NOT NULL,
    "trainingTo" TIMESTAMP(3) NOT NULL,
    "evalMetrics" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CuratorModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CuratorModel_status_createdAt_idx" ON "CuratorModel"("status", "createdAt");
