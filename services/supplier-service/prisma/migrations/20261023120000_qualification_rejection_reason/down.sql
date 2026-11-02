-- Reverses 20261023120000_qualification_rejection_reason.
--
-- **What a rollback costs.** The supplier-visible rejection reasons recorded on
-- the rows go with the column. Each was also published on its
-- `SUPPLIER_REJECTED` event, so whatever the topic and the outbox still retain
-- is where it can be found again; nothing else holds it. Re-applying the
-- migration backfills only from the outbox rows still present.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "qualification" DROP CONSTRAINT IF EXISTS "ck_qualification_rejected_has_reason";
ALTER TABLE "qualification" DROP CONSTRAINT IF EXISTS "ck_qualification_rejection_reason_shape";
ALTER TABLE "qualification" DROP COLUMN IF EXISTS "rejection_reason";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023120000_qualification_rejection_reason';
