-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 2).
--
-- Drops the tender table (its indexes, CHECKs and tenant-bound foreign key go
-- with it) and then its enums, which cannot be dropped while a column uses
-- them.
--
-- **This destroys every tender this service has stored**, including who created,
-- changed or cancelled them and why. Anything already published from the outbox
-- has left; audit-service keeps its own copy of every event it received.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "tender";

DROP TYPE IF EXISTS "TenderVisibility";
DROP TYPE IF EXISTS "ProcurementNature";
DROP TYPE IF EXISTS "TenderStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930160000_tender_core';
