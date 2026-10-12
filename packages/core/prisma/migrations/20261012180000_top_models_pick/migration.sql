-- The default feed's top 3 is picked once per 6-hour slot and stored, so every process reads the
-- same pick for the whole slot (topModels.ts). New table only; nothing existing changes.
CREATE TABLE IF NOT EXISTS "TopModelsPick" (
    "slotStart" TIMESTAMP(3) NOT NULL,
    "models" TEXT[],
    "pickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TopModelsPick_pkey" PRIMARY KEY ("slotStart")
);
