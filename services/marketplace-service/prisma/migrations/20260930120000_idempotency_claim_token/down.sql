-- Reverses 20260930120000_idempotency_claim_token.
--
-- Roll the code back BEFORE this runs. The previous code neither reads nor
-- writes the column, so it works against either schema.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key" DROP CONSTRAINT IF EXISTS "ck_idempotency_claim_token_not_blank";
ALTER TABLE "idempotency_key" DROP COLUMN IF EXISTS "claim_token";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930120000_idempotency_claim_token';
