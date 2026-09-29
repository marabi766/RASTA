-- Reverses 20260929120100_order_idempotency_key_unique. Dropping an index is a
-- catalogue change, so its exclusive lock is held for milliseconds.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "uq_order_org_idempotency_key";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260929120100_order_idempotency_key_unique';
