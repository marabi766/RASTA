-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, then the enums, which cannot be dropped while a column still
-- uses them. Indexes, CHECK constraints and foreign keys go with their tables.
-- No CASCADE: if a later migration's object still depends on one of these, its
-- own down.sql did not run, and this should fail rather than take it silently.
--
-- **This destroys every driver, assignment and usage record.** Usage already
-- published has been consumed by maintenance and asset; dropping the table
-- cannot recall it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "asset_ref";
DROP TABLE IF EXISTS "availability_window";

DROP TABLE IF EXISTS "usage_record";
DROP TABLE IF EXISTS "assignment";
DROP TABLE IF EXISTS "driver";

DROP TYPE IF EXISTS "UsageSource";
DROP TYPE IF EXISTS "AssignmentEndReason";
DROP TYPE IF EXISTS "DriverStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260827212937_init_fleet';
