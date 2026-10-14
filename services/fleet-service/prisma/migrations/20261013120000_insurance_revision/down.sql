-- Reverses 20261013120000_insurance_revision (#240 round 10).
--
-- Roll the code back first: this round's consumer reads both columns. Dropping
-- `next_attempt_at` loses only "due now" marks; those parked events are tried
-- again by the age rule. Dropping the revision loses nothing stored.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "insurance_pending_verification" DROP COLUMN IF EXISTS "next_attempt_at";

DROP TRIGGER IF EXISTS "asset_ref_insurance_revision" ON "asset_ref";
DROP FUNCTION IF EXISTS "asset_ref_insurance_revision"();
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_revision";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013120000_insurance_revision';

COMMIT;
