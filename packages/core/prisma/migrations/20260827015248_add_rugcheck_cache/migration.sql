-- CreateTable
CREATE TABLE "RugCheckCache" (
    "mintAddress" TEXT NOT NULL,
    "profile" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RugCheckCache_pkey" PRIMARY KEY ("mintAddress")
);

-- CreateIndex
CREATE INDEX "RugCheckCache_checkedAt_idx" ON "RugCheckCache"("checkedAt");
