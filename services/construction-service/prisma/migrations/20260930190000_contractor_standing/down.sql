-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 5).
--
-- Drops both tables. The read model is rebuilt by replaying rasta.supplier.v1
-- from the start of its retention; events older than that are not recoverable
-- here. The `_prisma_migrations` row is removed last so the forward migration
-- can be re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "contractor_suspension";
DROP TABLE IF EXISTS "contractor_standing";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930190000_contractor_standing';
