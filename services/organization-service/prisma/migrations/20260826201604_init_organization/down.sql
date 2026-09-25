-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, then the enums, which cannot be dropped while a column still
-- uses them. Indexes, CHECK constraints and foreign keys go with their tables.
-- No CASCADE: if a later migration's object still depends on one of these, its
-- own down.sql did not run, and this should fail rather than take it silently.
--
-- **This destroys the tenant registry** — every organization, its hierarchy,
-- locations, contacts and governance policy history. Every other service
-- holds references to these ids; none of them is told.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "outbox_message";

DROP TABLE IF EXISTS "organization_contact";
DROP TABLE IF EXISTS "organization_policy";
DROP TABLE IF EXISTS "organization_location";
DROP TABLE IF EXISTS "organization";

DROP TYPE IF EXISTS "ContactKind";
DROP TYPE IF EXISTS "LocationKind";
DROP TYPE IF EXISTS "OrganizationStatus";
DROP TYPE IF EXISTS "OrganizationType";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260826201604_init_organization';
