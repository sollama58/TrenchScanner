-- Weekly model backups (curation/modelBackup.ts). Safe to re-run: IF NOT EXISTS throughout.
CREATE TABLE IF NOT EXISTS "ModelBackup" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "modelCount" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "offsiteKey" TEXT,
    "offsiteAt" TIMESTAMP(3),
    "offsiteError" TEXT,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "ModelBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModelBackup_kind_createdAt_idx" ON "ModelBackup"("kind", "createdAt");
CREATE INDEX IF NOT EXISTS "ModelBackup_createdAt_idx" ON "ModelBackup"("createdAt");
