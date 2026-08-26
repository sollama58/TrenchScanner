-- CreateTable
CREATE TABLE "MintAuthorityCache" (
    "mintAddress" TEXT NOT NULL,
    "mintAuthorityActive" BOOLEAN NOT NULL,
    "freezeAuthorityActive" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MintAuthorityCache_pkey" PRIMARY KEY ("mintAddress")
);
