-- Weekly copies of the irreplaceable tables (backup/tableBackup.ts; database audit 2026-10-16, J1).
-- Safe to re-run: IF NOT EXISTS throughout.
CREATE TABLE IF NOT EXISTS "DataBackup" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "tables" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "offsiteKey" TEXT,
    "offsiteAt" TIMESTAMP(3),
    "offsiteError" TEXT,

    CONSTRAINT "DataBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DataBackup_createdAt_idx" ON "DataBackup"("createdAt");
