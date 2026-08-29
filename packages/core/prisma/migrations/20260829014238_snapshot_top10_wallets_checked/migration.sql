-- The denominator behind freshTop10WalletPct / emptyTop10WalletPct.
--
-- The "top 10" holder list excludes pool and LP addresses, so it is often shorter than ten.
-- Without the real count, a card rendering "4 of 10" from a percentage would be wrong exactly
-- when the list is short. Null on existing rows, which the UI shows as a percentage alone.
ALTER TABLE "TokenSnapshot" ADD COLUMN "top10WalletsChecked" INTEGER;
