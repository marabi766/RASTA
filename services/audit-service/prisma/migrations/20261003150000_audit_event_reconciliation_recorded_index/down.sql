-- Reverses 20261003150000_audit_event_reconciliation_recorded_index. Drops the
-- index only; no evidence row is touched.
DROP INDEX IF EXISTS audit_event_topic_event_recorded_idx;

-- Last, and not optional. `migrate deploy` decides what to apply from this
-- ledger alone, so a rollback that drops the index but leaves the row behind
-- makes the migration permanently unappliable: the next deploy reports itself
-- in sync, the missing-evidence detector falls back to a scan of every
-- partition once a minute, and nothing anywhere says so.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261003150000_audit_event_reconciliation_recorded_index';
