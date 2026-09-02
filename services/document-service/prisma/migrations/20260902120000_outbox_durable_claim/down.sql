-- Reverses 20260902120000_outbox_durable_claim (ADR-050).
--
-- Order matters only in that the code must be rolled back BEFORE this runs.
-- A new relay against a schema without these columns fails on every claim;
-- an old relay against a schema that still has them works fine, which is why
-- the forward direction is the safe one to be caught halfway through.
--
-- A row claimed but not yet acknowledged becomes immediately claimable again
-- once its fence is dropped, so the rollback itself can produce a duplicate
-- publication. At-least-once already permits that (G3); it is recorded in the
-- runbook so nobody meets it as a surprise.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ix_outbox_next_attempt";
DROP INDEX IF EXISTS "ix_outbox_claim_expiry";
DROP INDEX IF EXISTS "ix_outbox_claimable";

ALTER TABLE "outbox_message" DROP CONSTRAINT IF EXISTS "ck_outbox_next_attempt_requires_failure";
ALTER TABLE "outbox_message" DROP CONSTRAINT IF EXISTS "ck_outbox_published_is_clean";
ALTER TABLE "outbox_message" DROP CONSTRAINT IF EXISTS "ck_outbox_attempts_nonneg";
ALTER TABLE "outbox_message" DROP CONSTRAINT IF EXISTS "ck_outbox_claim_count_nonneg";
ALTER TABLE "outbox_message" DROP CONSTRAINT IF EXISTS "ck_outbox_claim_triple";

ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "next_attempt_at";
ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "claim_count";
ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "claim_expires_at";
ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "claim_owner";
ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "claim_token";

-- Prisma will not re-apply a migration whose row is still in its ledger, so a
-- rollback that leaves this behind cannot be rolled forward again.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260902120000_outbox_durable_claim';
