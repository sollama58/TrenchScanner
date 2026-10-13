-- Linked wallets (core's wallets/linkedWallets.ts) and each wallet's own trades in the trade tape.
-- Nullable columns with no default are catalog-only changes; the lock timeout keeps a TokenSnapshot
-- ALTER queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it).
-- IF NOT EXISTS throughout so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedWalletPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedClusterCount" INTEGER;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedLargestClusterPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedCreatorPct" DOUBLE PRECISION;
ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "linkedClusters" JSONB;

ALTER TABLE "UserFilter" ADD COLUMN IF NOT EXISTS "maxLinkedWalletPct" DOUBLE PRECISION;

ALTER TABLE "TokenWalletActivity" ADD COLUMN IF NOT EXISTS "trades" JSONB;

CREATE TABLE IF NOT EXISTS "WalletFunder" (
    "wallet" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "funder" TEXT,
    "amountSol" DOUBLE PRECISION,
    "fundedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletFunder_pkey" PRIMARY KEY ("wallet")
);
CREATE INDEX IF NOT EXISTS "WalletFunder_funder_idx" ON "WalletFunder"("funder");
CREATE INDEX IF NOT EXISTS "WalletFunder_checkedAt_idx" ON "WalletFunder"("checkedAt");

CREATE TABLE IF NOT EXISTS "FunderActivity" (
    "address" TEXT NOT NULL,
    "fullPageSpanMs" DOUBLE PRECISION,
    "hot" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FunderActivity_pkey" PRIMARY KEY ("address")
);
CREATE INDEX IF NOT EXISTS "FunderActivity_checkedAt_idx" ON "FunderActivity"("checkedAt");
