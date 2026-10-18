-- Pro Mode: who besides the admins sees the token modal's Trade panel (schema.prisma ProModeGrant).
CREATE TABLE IF NOT EXISTS "ProModeGrant" (
    "walletAddress" TEXT NOT NULL,
    "note" TEXT,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProModeGrant_pkey" PRIMARY KEY ("walletAddress")
);
