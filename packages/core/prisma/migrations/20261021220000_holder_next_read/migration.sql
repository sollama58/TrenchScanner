-- When the next chain enumeration of a coin's holder list is due. The schedule clock moves on a
-- chain read and on a quiet keep; a streamed balance does not move it, and it is not the
-- enumeration time the holders section shows. The countdown follows this column.
--
-- TokenSnapshot is written every scan. The ALTER waits only five seconds for its lock, then
-- migrate-deploy retries, so a long read cannot stall the table.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenSnapshot" ADD COLUMN IF NOT EXISTS "holderNextReadAt" TIMESTAMP(3);
