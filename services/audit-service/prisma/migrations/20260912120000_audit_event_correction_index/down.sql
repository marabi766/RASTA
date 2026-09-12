-- Reverses 20260912120000_audit_event_correction_index. Drops the index only;
-- no evidence row is touched.
DROP INDEX IF EXISTS audit_event_correction_idx;

-- Last, and not optional. `migrate deploy` decides what to apply from this
-- ledger alone, so a rollback that drops the index but leaves the row behind
-- makes the migration permanently unappliable: the next deploy reports itself
-- in sync, the `correctedBy` lookup falls back to a scan of every partition
-- since the target, and nothing anywhere says so.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260912120000_audit_event_correction_index';
