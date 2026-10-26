-- Asyl watchlists (user ask 2026-10-26): the wallets each user watches, and the newest activity
-- they have seen. A new table, so nothing existing is locked for long. Safe to re-run.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "AsylWatch" (
    "userId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "name" TEXT,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsylWatch_pkey" PRIMARY KEY ("userId","wallet")
);
DO $$ BEGIN
  ALTER TABLE "AsylWatch" ADD CONSTRAINT "AsylWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
