-- When each cached wallet's current stretch of activity began, and its newest transaction, for the
-- fresh-wallet checks (an aged wallet paid again today reads fresh). Nullable columns with no
-- default are catalog-only changes. IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "WalletActivityCache" ADD COLUMN IF NOT EXISTS "activeSince" TIMESTAMP(3);
ALTER TABLE "WalletActivityCache" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);
