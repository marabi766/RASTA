-- Reverses 20261004100100_membership_one_live_index. Dropping an index is a
-- catalogue change, so its exclusive lock is held for milliseconds.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "ux_membership_live_user_org";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100100_membership_one_live_index';
