-- Reverses 20260912120000_audit_event_correction_index. Drops the index only;
-- no evidence row is touched.
DROP INDEX IF EXISTS audit_event_correction_idx;
