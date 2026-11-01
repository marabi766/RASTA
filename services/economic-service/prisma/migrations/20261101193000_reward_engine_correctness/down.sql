BEGIN;
SET LOCAL lock_timeout = '3s';
-- Hold the refusal check and DROP against concurrent status writers.
LOCK TABLE reward_rule_status_history IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reward_rule_status_history) THEN
    RAISE EXCEPTION 'reward_rule_status_history holds applicability evidence; refusing rollback'
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DROP TABLE reward_rule_status_history;
DROP FUNCTION reject_reward_rule_status_mutation();
DROP INDEX reward_organization_id_user_id_rule_id_occurred_at_idx;
ALTER TABLE reward DROP COLUMN occurred_at;
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101193000_reward_engine_correctness';
COMMIT;
