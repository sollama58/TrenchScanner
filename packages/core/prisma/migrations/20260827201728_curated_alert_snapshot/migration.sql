-- AlterTable
ALTER TABLE "CuratedAlert" ADD COLUMN     "snapshotId" TEXT;

-- AddForeignKey
ALTER TABLE "CuratedAlert" ADD CONSTRAINT "CuratedAlert_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "TokenSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
