-- Reverse of `migration.sql` (20261015120000_idempotency_actor_claim_token).
--
-- Drops the actor binding and the claim tokens. Run with the previous release
-- deployed: it neither writes nor reads them. Records keep their keys, bodies
-- and answers, so retries still replay — bound again only by tenant, endpoint
-- and request body, as before.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key"
  DROP COLUMN IF EXISTS "claim_token",
  DROP COLUMN IF EXISTS "actor_hash";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015120000_idempotency_actor_claim_token';

COMMIT;
