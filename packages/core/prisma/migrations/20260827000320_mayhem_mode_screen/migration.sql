-- AlterTable
ALTER TABLE "TokenSnapshot" ADD COLUMN     "isMayhemMode" BOOLEAN;

-- CreateTable
CREATE TABLE "MayhemModeCache" (
    "mintAddress" TEXT NOT NULL,
    "isMayhemMode" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MayhemModeCache_pkey" PRIMARY KEY ("mintAddress")
);

-- CreateIndex
CREATE INDEX "MayhemModeCache_checkedAt_idx" ON "MayhemModeCache"("checkedAt");
