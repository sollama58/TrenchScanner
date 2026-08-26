-- AlterTable
ALTER TABLE "TokenSnapshot" ADD COLUMN     "freshTop10WalletPct" DOUBLE PRECISION,
ADD COLUMN     "graduated" BOOLEAN,
ADD COLUMN     "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "riskScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "UserFilter" ADD COLUMN     "excludeCriticalRiskFlags" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxDevWalletPct" DOUBLE PRECISION,
ADD COLUMN     "maxFreshTop10WalletPct" DOUBLE PRECISION,
ADD COLUMN     "maxRiskScore" DOUBLE PRECISION;
