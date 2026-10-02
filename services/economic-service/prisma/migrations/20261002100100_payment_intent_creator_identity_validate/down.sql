-- Reverse of `migration.sql` (20261002100100_payment_intent_creator_identity_validate): the constraint goes back to NOT VALID.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  DROP CONSTRAINT IF EXISTS "ck_payment_intent_creator_identity";

ALTER TABLE "payment_intent"
  ADD CONSTRAINT "ck_payment_intent_creator_identity"
  CHECK (num_nonnulls("created_by_issuer", "created_by_subject") IN (0, 2)
         AND ("created_by_issuer" IS NULL OR btrim("created_by_issuer") <> '')
         AND ("created_by_subject" IS NULL OR btrim("created_by_subject") <> ''))
  NOT VALID;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002100100_payment_intent_creator_identity_validate';

COMMIT;
