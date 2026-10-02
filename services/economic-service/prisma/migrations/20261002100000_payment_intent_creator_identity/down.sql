-- Reverse of `migration.sql` (20261002100000_payment_intent_creator_identity).
--
-- Drops the recorded creator identities. The operator path then has nothing
-- to compare an approver's identity against; it is the B3 migration's own
-- rollback (20261001100000) that removes the path itself.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent" DROP CONSTRAINT IF EXISTS "ck_payment_intent_creator_identity";
ALTER TABLE "payment_intent"
  DROP COLUMN IF EXISTS "created_by_subject",
  DROP COLUMN IF EXISTS "created_by_issuer";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002100000_payment_intent_creator_identity';

COMMIT;
