-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: the need
-- table before the project it references, then the enums, which cannot be
-- dropped while a column still uses them. Indexes and CHECK constraints go
-- with their tables.
--
-- **This destroys every project and need this service has stored**, including
-- who created, submitted, withdrew or cancelled them and why. Anything already
-- published from the outbox has left: dropping the table cannot recall it, and
-- audit-service keeps its own copy of every event it received.
--
-- The PostGIS extension is left in place: the init script installed it, not
-- this migration, and other objects in the database may depend on it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "outbox_stream_sequence";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "idempotency_key";

DROP TABLE IF EXISTS "project_need";
DROP TABLE IF EXISTS "project";

DROP TYPE IF EXISTS "IdempotencyState";
DROP TYPE IF EXISTS "ProjectNeedStatus";
DROP TYPE IF EXISTS "ProjectStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926120000_init_construction';
