-- The Sacrifice's fee tier (ASDF fee plan, Build guide step 3): each holder's free-tier start, and
-- the one settings row (mode "off" and free cut-off 250 until an admin saves; sacrifice.ts).
ALTER TABLE "ProHolder" ADD COLUMN IF NOT EXISTS "freeTierSince" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "SacrificeSettings" (
    "id" TEXT NOT NULL DEFAULT 'sacrifice',
    "mode" TEXT NOT NULL DEFAULT 'off',
    "freeRank" INTEGER NOT NULL DEFAULT 250,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SacrificeSettings_pkey" PRIMARY KEY ("id")
);
