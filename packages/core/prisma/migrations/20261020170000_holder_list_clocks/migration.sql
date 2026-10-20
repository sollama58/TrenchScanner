-- The holder list and the wide bubble map record when their shares were current, apart from
-- when the scan row was written and when the chain last enumerated the wallets. The token view
-- was moving shares from the scan time, so trades in between were neither in the stored shares
-- nor applied live, and a later stream update was counted twice on the wide map.
--
-- TokenSnapshot is written every scan. The ALTER waits only five seconds for its lock, then
-- migrate-deploy retries, so a long read cannot stall the table.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN "holderBalancesAt" TIMESTAMP(3),
ADD COLUMN "holderChainReadAt" TIMESTAMP(3);

ALTER TABLE "BubbleMapHolders" ADD COLUMN "balancesAt" TIMESTAMP(3);
