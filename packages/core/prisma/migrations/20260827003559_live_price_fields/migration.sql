-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "liveDataAt" TIMESTAMP(3),
ADD COLUMN     "liveMarketCapUsd" DOUBLE PRECISION,
ADD COLUMN     "livePriceUsd" DOUBLE PRECISION;
