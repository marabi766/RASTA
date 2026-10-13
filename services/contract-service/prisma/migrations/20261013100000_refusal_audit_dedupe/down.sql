-- =============================================================================
-- Reverse of `migration.sql` (20261013100000_refusal_audit_dedupe, #243 round 2).
--
-- Drops the de-duplication table. Its rows are a cache of which refusals were already audited,
-- not a record: the audit events themselves are in the outbox and the audit service. Roll the
-- code back first: it writes the table, and without it a repeated refusal is audited again.
--
-- One transaction; the `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS "refusal_audit_dedupe";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013100000_refusal_audit_dedupe';

COMMIT;
