-- Reverses 20261004100200_drop_membership_deleted_at_unique.
--
-- This script is one transaction (it must also delete its own ledger row, and
-- CONCURRENTLY cannot share a script), so the build below blocks writes to
-- `membership` while it runs. To take no such lock, run this first on its own —
-- the IF NOT EXISTS below then finds the index built:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "membership_user_id_organization_id_deleted_at_key" ON "membership" ("user_id", "organization_id", "deleted_at");
--
-- The bound measured, and the operator path: docs/runbooks/database-bootstrap.md#identity-one-live-membership.
SET LOCAL lock_timeout = '5s';

-- A pre-build that failed leaves the index INVALID, and IF NOT EXISTS below
-- would take it for the real key: refuse instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = to_regclass('membership_user_id_organization_id_deleted_at_key')
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'membership_user_id_organization_id_deleted_at_key is INVALID; refusing to roll back onto it'
      USING HINT = 'DROP INDEX CONCURRENTLY it on its own, build it again, then run this script.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "membership_user_id_organization_id_deleted_at_key" ON "membership"("user_id", "organization_id", "deleted_at");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100200_drop_membership_deleted_at_unique';
