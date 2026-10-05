-- Reverses 20261005130000_availability_window_one_live (review #225 round 1).
--
-- Roll the code back first: the declaration path relies on the index only as a
-- backstop, and the transfer fence writes `revoke_reason`. Dropping the column
-- forgets why the system revoked a window; the windows stay revoked.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_availability_window_live";
ALTER TABLE "availability_window" DROP COLUMN IF EXISTS "revoke_reason";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005130000_availability_window_one_live';
