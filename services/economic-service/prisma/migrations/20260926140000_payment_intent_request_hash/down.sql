-- Reverses 20260926140000_payment_intent_request_hash.
--
-- Drops the recorded request hash. Roll the application back first: the code
-- that writes and compares it expects the column.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "payment_intent"
  DROP CONSTRAINT IF EXISTS "ck_payment_intent_request_hash";

ALTER TABLE "payment_intent"
  DROP COLUMN IF EXISTS "request_hash";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926140000_payment_intent_request_hash';
