-- AlterTable
ALTER TABLE "ProModeGrant" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProHolder" ADD COLUMN "bagMovedAt" TIMESTAMP(3);
