-- =============================================================================
-- Reverse of `migration.sql` (20261008120000_reconciliation_earliest_moved_at, CON-003 PR 2 round 10).
--
-- Drops the column; the task keeps `moved_at`, the instant of the move whose version it holds. No
-- review or signature row depends on it, so nothing is refused.
--
-- One transaction (`BEGIN; … COMMIT;`): the change and the ledger row commit together or not at all,
-- run with `psql --file` or `-c`, with `ON_ERROR_STOP` or without it.
-- =============================================================================

BEGIN;

LOCK TABLE "policy_reconciliation_task" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "policy_reconciliation_task" DROP COLUMN IF EXISTS "earliest_moved_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261008120000_reconciliation_earliest_moved_at';

COMMIT;
