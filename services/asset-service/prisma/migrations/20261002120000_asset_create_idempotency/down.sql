-- Reverses 20261002120000_asset_create_idempotency (#169).
--
-- Roll the code back first: the create path claims and completes rows here.
-- Nothing is refused: the previous code never reads this table, so the rows
-- stay, harmless, and the columns return to their earlier types (UTC values,
-- converted back as they were converted forward). What is lost is the
-- protection itself — a client retry within the retention window registers a
-- second asset again, the behaviour before #169.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key"
  DROP CONSTRAINT IF EXISTS "ck_idempotency_completed_has_response",
  DROP CONSTRAINT IF EXISTS "ck_idempotency_claim_token_not_blank",
  DROP CONSTRAINT IF EXISTS "ck_idempotency_key_not_blank",
  DROP CONSTRAINT IF EXISTS "ck_idempotency_state",
  DROP COLUMN IF EXISTS "claim_token",
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3) USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "expires_at" TYPE TIMESTAMP(3) USING "expires_at" AT TIME ZONE 'UTC';

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002120000_asset_create_idempotency';

COMMIT;
