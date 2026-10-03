-- Discovery metadata on Token: the Pump.fun description, which source found the mint, whether
-- DexScreener ever listed it as boosted, and when it first entered the curated band.
ALTER TABLE "Token" ADD COLUMN "description" TEXT;
ALTER TABLE "Token" ADD COLUMN "discoverySource" TEXT;
ALTER TABLE "Token" ADD COLUMN "dexBoosted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Token" ADD COLUMN "firstInBandAt" TIMESTAMP(3);
