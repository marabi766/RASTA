-- =============================================================================
-- Reverse of `migration.sql` (PM decision D-065): the replay deadline column and its constraint go.
--
-- The stored deadlines are forgotten: the records they belonged to behave as records written before the
-- migration (an expired key is reusable again), which is what the code of that version does. No record is
-- deleted or rewritten. Locks the table first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "idempotency_key" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "idempotency_key" DROP CONSTRAINT "ck_idempotency_replay_deadline_within_expiry";
ALTER TABLE "idempotency_key" DROP COLUMN "replay_deadline_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024120000_idempotency_replay_deadline';

COMMIT;
