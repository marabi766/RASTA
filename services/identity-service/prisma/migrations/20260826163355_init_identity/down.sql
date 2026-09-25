-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, then the enums, which cannot be dropped while a column still
-- uses them. Indexes, CHECK constraints and foreign keys go with their tables.
-- No CASCADE: if a later migration's object still depends on one of these, its
-- own down.sql did not run, and this should fail rather than take it silently.
--
-- **This destroys every user, membership and registration request** in this
-- service. Keycloak accounts are not touched and would be left without the
-- platform user they point at.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "organization_ref";

DROP TABLE IF EXISTS "registration_request";
DROP TABLE IF EXISTS "role_permission";
DROP TABLE IF EXISTS "permission";
DROP TABLE IF EXISTS "role";
DROP TABLE IF EXISTS "membership";
DROP TABLE IF EXISTS "user";

DROP TYPE IF EXISTS "RegistrationStatus";
DROP TYPE IF EXISTS "ScopeLevel";
DROP TYPE IF EXISTS "MembershipStatus";
DROP TYPE IF EXISTS "UserStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260826163355_init_identity';
