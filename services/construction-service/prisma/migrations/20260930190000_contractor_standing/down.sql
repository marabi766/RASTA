-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 5).
--
-- Drops the three tables and the marker's guard. The read model is rebuilt by the
-- **bootstrap**: re-applying the migration leaves no marker, so construction-service
-- loads the standing again from supplier-service's snapshot
-- (`GET /v1/suppliers/standing-snapshot`) when it next starts, and until it has
-- nobody is eligible to bid (fail closed). The event log cannot rebuild it: the
-- consumer group starts at the end of a seven-day log. Procedure:
-- docs/runbooks/contractor-standing-bootstrap.md.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_standing_bootstrap_guard" ON "standing_bootstrap";
DROP FUNCTION IF EXISTS "standing_bootstrap_guard"();

DROP TABLE IF EXISTS "standing_bootstrap";
DROP TABLE IF EXISTS "contractor_suspension";
DROP TABLE IF EXISTS "contractor_standing";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930190000_contractor_standing';
