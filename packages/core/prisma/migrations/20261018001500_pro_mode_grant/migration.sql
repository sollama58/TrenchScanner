-- Pro Mode: who besides the admins sees the token modal's Trade panel (schema.prisma ProModeGrant).
CREATE TABLE IF NOT EXISTS "ProModeGrant" (
    "walletAddress" TEXT NOT NULL,
    "note" TEXT,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProModeGrant_pkey" PRIMARY KEY ("walletAddress")
);

-- Pro Mode for the top 250 $ASDFASDFA holders, with a 24-hour grace after dropping out (ProHolder).
CREATE TABLE IF NOT EXISTS "ProHolder" (
    "walletAddress" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "lastInTopAt" TIMESTAMP(3) NOT NULL,
    "firstInTopAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProHolder_pkey" PRIMARY KEY ("walletAddress")
);
CREATE INDEX IF NOT EXISTS "ProHolder_lastInTopAt_idx" ON "ProHolder"("lastInTopAt");

-- Wallets that have had Pro Mode: they can always sell what they hold (ProModeSeen).
CREATE TABLE IF NOT EXISTS "ProModeSeen" (
    "walletAddress" TEXT NOT NULL,
    "lastProAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProModeSeen_pkey" PRIMARY KEY ("walletAddress")
);
