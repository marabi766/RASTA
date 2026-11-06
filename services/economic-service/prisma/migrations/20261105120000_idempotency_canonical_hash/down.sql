-- Reverse of `migration.sql` (20261105120000_idempotency_canonical_hash).
--
-- Drops the canonical hashes. Run with the previous release deployed: it neither
-- writes nor reads them. Every record keeps `request_hash`, the hash of the body
-- as sent, so the unchanged retry still replays; another spelling of it is
-- `409 IDEMPOTENCY_KEY_REUSED` again until the record expires, as before.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key"
  DROP COLUMN IF EXISTS "canonical_hash";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105120000_idempotency_canonical_hash';

COMMIT;
