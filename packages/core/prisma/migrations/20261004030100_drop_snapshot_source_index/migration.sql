-- TokenSnapshot(source, takenAt) was added for the fast-match candidate query, which since #64
-- reads the scan's in-memory record instead, and whose post-restart fallback now goes through
-- Token and TokenSnapshot(tokenId, takenAt). Production never had this index at all (see
-- 20260903020000_snapshot_source_index: it was marked applied for an out-of-band build that did
-- not happen), so this only brings fresh installs in line with production and the schema.
--
-- One statement, CONCURRENTLY, IF EXISTS - see 20261004030000_drop_snapshot_mcap_index.
DROP INDEX CONCURRENTLY IF EXISTS "TokenSnapshot_source_takenAt_idx";
