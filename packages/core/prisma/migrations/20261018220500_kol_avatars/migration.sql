-- KOL profile pictures (user ask 2026-10-18): each KOL's X picture, fetched by the worker and
-- served by the API (schema.prisma KolAvatar). One new, empty table: no lock on anything that holds rows.
CREATE TABLE IF NOT EXISTS "KolAvatar" (
    "handle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "image" BYTEA,
    "contentType" TEXT,
    "hash" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KolAvatar_pkey" PRIMARY KEY ("handle")
);
CREATE INDEX IF NOT EXISTS "KolAvatar_fetchedAt_idx" ON "KolAvatar"("fetchedAt");
