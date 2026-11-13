BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_full_run IN ACCESS EXCLUSIVE MODE;
-- An activated installation must keep the marker/refusals and a compatible image.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_full_run WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ACTIVE_METER_FULL_RUN_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TABLE meter_full_run_asset;
DROP TABLE meter_full_run;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113130000_meter_full_run';
COMMIT;
