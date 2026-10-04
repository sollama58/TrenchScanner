-- Evolving curator contest: each learner seat's current recipe and its history, and the name a
-- model held when it made a call. Re-runnable: every statement is IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "CuratorLane" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recipe" JSONB NOT NULL,
    "generation" INTEGER NOT NULL,
    "parentName" TEXT,
    "examScore" DOUBLE PRECISION,
    "bornAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,

    CONSTRAINT "CuratorLane_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CuratorLane_slot_retiredAt_idx" ON "CuratorLane"("slot", "retiredAt");
CREATE INDEX IF NOT EXISTS "CuratorLane_bornAt_idx" ON "CuratorLane"("bornAt");

ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "modelName" TEXT;
