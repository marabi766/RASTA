-- =============================================================================
-- Reverse of `migration.sql` (20260930150000_policy_reconciliation_task).
--
-- Drops the queue, open tasks included: a policy whose task was still waiting
-- is no longer re-checked after a move until a round is opened on it.
-- =============================================================================

DROP TABLE IF EXISTS "policy_reconciliation_task";
DROP TYPE IF EXISTS "PolicyReconciliationStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930150000_policy_reconciliation_task';
