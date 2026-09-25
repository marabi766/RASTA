-- Reverses 20260925200000_reward_source_evaluation.
--
-- Drops the table, and with it the guarantee, not any money: rewards and
-- journals are untouched. The consumer then has only processed_event and
-- (rule_id, source_reference) again, which is the state before this
-- migration. The rows cannot be recovered by re-running up: its backfill
-- restores the facts that were paid, not the ones evaluated with no rule.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "reward_source_evaluation";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925200000_reward_source_evaluation';

COMMIT;
