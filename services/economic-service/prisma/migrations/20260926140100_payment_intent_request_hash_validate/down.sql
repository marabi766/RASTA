-- Reverses 20260926140100_payment_intent_request_hash_validate.
--
-- PostgreSQL has no statement that marks a validated constraint NOT VALID
-- again, so the constraint is dropped and re-added exactly as 20260926140000
-- left it. NOT VALID makes the re-add catalogue-only: no row is scanned.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  DROP CONSTRAINT IF EXISTS "ck_payment_intent_request_hash";

ALTER TABLE "payment_intent"
  ADD CONSTRAINT "ck_payment_intent_request_hash"
  CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$')
  NOT VALID;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926140100_payment_intent_request_hash_validate';
