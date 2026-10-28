-- Trade Buddy's linked wallets (user decision 2026-10-27, Card 11): a new, empty table. Safe to re-run.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "BuddyWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuddyWallet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BuddyWallet_userId_wallet_key" ON "BuddyWallet"("userId", "wallet");
DO $$ BEGIN
  ALTER TABLE "BuddyWallet" ADD CONSTRAINT "BuddyWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
