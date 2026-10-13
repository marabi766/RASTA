-- Reverses 20261013180000_insurance_epoch (#240 round 11).
--
-- Roll the code back first: this round's consumer and
-- `insurance:clear-transferred` read the column. Dropping it loses nothing
-- stored. Like any rollback of these migrations it is done with every
-- asset-service replica stopped (runbook insurance-reprojection.md).
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_epoch";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013180000_insurance_epoch';

COMMIT;
