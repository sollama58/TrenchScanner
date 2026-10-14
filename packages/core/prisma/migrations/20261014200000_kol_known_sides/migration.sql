-- Known Sides (user ask 2026-10-14): a KOL's other roster entries point at its main wallet. A
-- nullable column with no default, so adding it rewrites nothing.
ALTER TABLE "KolWallet" ADD COLUMN IF NOT EXISTS "mainWallet" TEXT;

CREATE INDEX IF NOT EXISTS "KolWallet_mainWallet_idx" ON "KolWallet"("mainWallet");
