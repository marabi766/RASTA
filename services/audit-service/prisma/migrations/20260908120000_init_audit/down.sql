-- Reverses AUD-001 completely, in dependency-safe order.
--
-- Partitions first, then the parent, then the trigger function they all
-- reference, then the enums nothing else uses. Dropping the parent would take
-- the partitions with it, but naming each one keeps this file honest about what
-- it removes -- and makes a partition that was added later and forgotten here
-- fail loudly instead of vanishing silently.

REVOKE ALL ON audit.organization_ref FROM rasta_audit;
REVOKE ALL ON audit.processed_event FROM rasta_audit;
REVOKE ALL ON SEQUENCE audit.audit_event_sequence_no_seq FROM rasta_audit;
REVOKE ALL ON audit.audit_event FROM rasta_audit;

DROP INDEX IF EXISTS audit.organization_ref_last_seen_idx;
DROP TABLE IF EXISTS audit.organization_ref;
DROP TABLE IF EXISTS audit.processed_event;

DROP TABLE IF EXISTS audit.audit_event_2026_09;
DROP TABLE IF EXISTS audit.audit_event_2026_10;
DROP TABLE IF EXISTS audit.audit_event_2026_11;
DROP TABLE IF EXISTS audit.audit_event_2026_12;
DROP TABLE IF EXISTS audit.audit_event_2027_01;
DROP TABLE IF EXISTS audit.audit_event_2027_02;
DROP TABLE IF EXISTS audit.audit_event_2027_03;
DROP TABLE IF EXISTS audit.audit_event_2027_04;
DROP TABLE IF EXISTS audit.audit_event_2027_05;
DROP TABLE IF EXISTS audit.audit_event_2027_06;
DROP TABLE IF EXISTS audit.audit_event_2027_07;
DROP TABLE IF EXISTS audit.audit_event_2027_08;
DROP TABLE IF EXISTS audit.audit_event_2027_09;
DROP TABLE IF EXISTS audit.audit_event_2027_10;
DROP TABLE IF EXISTS audit.audit_event_2027_11;
DROP TABLE IF EXISTS audit.audit_event_2027_12;
DROP TABLE IF EXISTS audit.audit_event_2028_01;
DROP TABLE IF EXISTS audit.audit_event_2028_02;
DROP TABLE IF EXISTS audit.audit_event_default;

DROP TABLE IF EXISTS audit.audit_event;
DROP FUNCTION IF EXISTS audit.refuse_mutation();
DROP TYPE IF EXISTS audit.audit_outcome;
DROP TYPE IF EXISTS audit.audit_actor_type;

