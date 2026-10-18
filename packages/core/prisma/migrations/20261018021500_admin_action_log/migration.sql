-- The admin action log (the AdminAction model): every admin write, who made it and how it ended.
-- A new table, so no lock on a busy one; safe to re-run.
CREATE TABLE IF NOT EXISTS "AdminAction" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wallet" TEXT NOT NULL,
    "deviceId" TEXT,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "detail" JSONB,
    "statusCode" INTEGER NOT NULL,
    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdminAction_at_idx" ON "AdminAction"("at");
