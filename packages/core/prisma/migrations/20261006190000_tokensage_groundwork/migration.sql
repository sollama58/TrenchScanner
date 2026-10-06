-- TokenSage groundwork: the launcher's X/website links on Token, and a per-mint cache of
-- TokenSage's narrative analysis. Nothing writes TokenNarrative until TOKENSAGE_ENABLED is on.
-- Safe to re-run.
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "twitterUrl" TEXT;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "websiteUrl" TEXT;

CREATE TABLE IF NOT EXISTS "TokenNarrative" (
    "mintAddress" TEXT NOT NULL,
    "depth" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "categories" JSONB,
    "referentLabel" TEXT,
    "referentKind" TEXT,
    "summary" TEXT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rulesVersion" TEXT,
    "analysis" JSONB,
    "analyzedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenNarrative_pkey" PRIMARY KEY ("mintAddress")
);

CREATE INDEX IF NOT EXISTS "TokenNarrative_checkedAt_idx" ON "TokenNarrative"("checkedAt");
