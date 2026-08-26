-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "lastViewedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Token_lastViewedAt_idx" ON "Token"("lastViewedAt");
