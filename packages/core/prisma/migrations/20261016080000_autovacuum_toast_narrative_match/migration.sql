SET LOCAL lock_timeout = '5s';

-- Autovacuum thresholds where 20261014091500_big_table_autovacuum left the defaults (db audit
-- 2026-10-16: C7, with A2 and A3).
--
-- A table's storage parameters do not reach its TOAST table. TokenSnapshot's holder lists live
-- out of line (its TOAST was 1,246 MB on 2026-10-16, 37 MB two days before), and that TOAST table
-- has its own autovacuum settings (toast.*), still at the default 20%. The nightly sweep deletes
-- hundreds of thousands of toasted rows at once, which clears the default line anyway; the same
-- threshold as the heap keeps the two in step on the nights it does not, which are coming: with
-- the holder list written on change only the TOAST shrinks, and the nightly batch with it.
--
-- TokenNarrative takes ~45 k UPDATEs a night from the document strips plus the hourly now-reads,
-- and showed 41.5 k dead rows (11.6%) with no setting of its own. Match's peak writes are non-HOT
-- (each changes the indexed peakMcapAt), and it sat at the 20% line between vacuums, with 126 MB
-- of indexes on a 58 MB heap. The same 2% / 1% as the four tables of 20261014091500, for the same
-- reasons; storage parameters only, so no rewrite and a SHARE UPDATE EXCLUSIVE lock (reads and
-- writes carry on). Prisma's schema can't express them, and its drift check ignores them.
ALTER TABLE "TokenSnapshot" SET (toast.autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "TokenNarrative" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01, toast.autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "Match" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
