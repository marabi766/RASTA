-- Reverses 20261004100200_drop_membership_deleted_at_unique.
--
-- This script is one transaction (it must also delete its own ledger row, and
-- CONCURRENTLY cannot share a script), so the build below blocks writes to
-- `membership` while it runs. To take no such lock, run this first on its own —
-- the IF NOT EXISTS below then finds the index built:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "membership_user_id_organization_id_deleted_at_key" ON "membership" ("user_id", "organization_id", "deleted_at");
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS "membership_user_id_organization_id_deleted_at_key" ON "membership"("user_id", "organization_id", "deleted_at");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100200_drop_membership_deleted_at_unique';
