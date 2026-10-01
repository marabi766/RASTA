-- Reverses 20260930140000_request_idempotency_key (#157).
--
-- Roll the code back first: the create path claims and completes rows here.
-- Dropping the table forgets every live key, so a client retry within the
-- retention window raises the work again — the behaviour before #157.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "idempotency_key";
DROP TYPE IF EXISTS "IdempotencyState";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930140000_request_idempotency_key';
