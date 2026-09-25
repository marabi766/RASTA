-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, then the enums, which cannot be dropped while a column still
-- uses them. Indexes, CHECK constraints and foreign keys go with their tables.
-- No CASCADE: if a later migration's object still depends on one of these, its
-- own down.sql did not run, and this should fail rather than take it silently.
--
-- **This destroys every schedule, request, repair order and cost record.**
-- Costs already published to economic have been acted on; dropping the table
-- cannot recall them.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "asset_usage_meter";
DROP TABLE IF EXISTS "asset_ref";

DROP TABLE IF EXISTS "maintenance_cost";
DROP TABLE IF EXISTS "labor_entry";
DROP TABLE IF EXISTS "part_usage";
DROP TABLE IF EXISTS "repair_order";
DROP TABLE IF EXISTS "maintenance_request";
DROP TABLE IF EXISTS "maintenance_schedule";

DROP TYPE IF EXISTS "MaintenanceCostCategory";
DROP TYPE IF EXISTS "PartSource";
DROP TYPE IF EXISTS "RepairOrderStatus";
DROP TYPE IF EXISTS "BreakdownSeverity";
DROP TYPE IF EXISTS "MaintenanceRequestStatus";
DROP TYPE IF EXISTS "ScheduleStatus";
DROP TYPE IF EXISTS "ScheduleRecurrence";
DROP TYPE IF EXISTS "MaintenanceType";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260828120126_init_maintenance';
