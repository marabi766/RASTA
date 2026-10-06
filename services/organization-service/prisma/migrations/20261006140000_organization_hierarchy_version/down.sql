-- Reverse of `migration.sql` (20261006140000_organization_hierarchy_version).
--
-- Roll contract-service back first (it records the version it read on each signature), or not at
-- all: once the column is gone organization-service stops answering and publishing a version, and
-- a contract-service that still expects one refuses to confirm the hierarchy (fail closed).
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "organization_hierarchy_version_idx";
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "ck_organization_hierarchy_version_positive";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "hierarchy_version";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261006140000_organization_hierarchy_version';
