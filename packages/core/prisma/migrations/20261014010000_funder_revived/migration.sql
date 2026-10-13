-- A wallet funder row's newest transaction when read, so the row is read again once the wallet
-- could have sat a week idle and been paid by someone new, and whether the funder is that new
-- payer (the revived farm on mdj29p8m...pump, 2026-10-13). Nullable columns with no default are
-- catalog-only changes. IF NOT EXISTS so a partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "WalletFunder" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);
ALTER TABLE "WalletFunder" ADD COLUMN IF NOT EXISTS "revived" BOOLEAN;
