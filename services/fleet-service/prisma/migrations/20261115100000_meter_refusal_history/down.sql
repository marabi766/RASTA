BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_refusal_history IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF EXISTS(SELECT 1 FROM meter_refusal_history) THEN
    RAISE EXCEPTION 'ACTIVE_REFUSAL_HISTORY_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TABLE meter_refusal_history;
DROP FUNCTION meter_refusal_history_fixed();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115100000_meter_refusal_history';
COMMIT;
