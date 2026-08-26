-- CreateTable
CREATE TABLE "WalletActivityCache" (
    "address" TEXT NOT NULL,
    "earliestActivityAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletActivityCache_pkey" PRIMARY KEY ("address")
);
