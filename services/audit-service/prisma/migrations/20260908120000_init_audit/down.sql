-- Reverses AUD-001 completely, in dependency-safe order.
--
-- Partitions first, then the parent, then the trigger function they all
-- reference, then the enums nothing else uses. Dropping the parent would take
-- the partitions with it, but naming each one keeps this file honest about what
-- it removes -- and makes a partition that was added later and forgotten here
-- fail loudly instead of vanishing silently.

REVOKE ALL ON organization_ref FROM rasta_audit;
REVOKE ALL ON processed_event FROM rasta_audit;
REVOKE ALL ON SEQUENCE audit_event_sequence_no_seq FROM rasta_audit;
REVOKE ALL ON audit_event FROM rasta_audit;

DROP INDEX IF EXISTS organization_ref_last_seen_idx;
DROP TABLE IF EXISTS organization_ref;
DROP TABLE IF EXISTS processed_event;

DROP TABLE IF EXISTS audit_event_2026_09;
DROP TABLE IF EXISTS audit_event_2026_10;
DROP TABLE IF EXISTS audit_event_2026_11;
DROP TABLE IF EXISTS audit_event_2026_12;
DROP TABLE IF EXISTS audit_event_2027_01;
DROP TABLE IF EXISTS audit_event_2027_02;
DROP TABLE IF EXISTS audit_event_2027_03;
DROP TABLE IF EXISTS audit_event_2027_04;
DROP TABLE IF EXISTS audit_event_2027_05;
DROP TABLE IF EXISTS audit_event_2027_06;
DROP TABLE IF EXISTS audit_event_2027_07;
DROP TABLE IF EXISTS audit_event_2027_08;
DROP TABLE IF EXISTS audit_event_2027_09;
DROP TABLE IF EXISTS audit_event_2027_10;
DROP TABLE IF EXISTS audit_event_2027_11;
DROP TABLE IF EXISTS audit_event_2027_12;
DROP TABLE IF EXISTS audit_event_2028_01;
DROP TABLE IF EXISTS audit_event_2028_02;
DROP TABLE IF EXISTS audit_event_default;

DROP TABLE IF EXISTS audit_event;
DROP FUNCTION IF EXISTS refuse_mutation();
DROP TYPE IF EXISTS audit_outcome;
DROP TYPE IF EXISTS audit_actor_type;

-- Last, and not optional. Without it `migrate deploy` still believes this
-- migration is applied and re-applies nothing, so an up -> down -> up cycle
-- silently ends with an empty schema that reports success.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260908120000_init_audit';

