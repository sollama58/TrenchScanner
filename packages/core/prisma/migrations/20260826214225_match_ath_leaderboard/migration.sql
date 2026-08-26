-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "hitHundredPctAt" TIMESTAMP(3),
ADD COLUMN     "peakReturnPct" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "Match_hitHundredPctAt_peakReturnPct_idx" ON "Match"("hitHundredPctAt", "peakReturnPct");
