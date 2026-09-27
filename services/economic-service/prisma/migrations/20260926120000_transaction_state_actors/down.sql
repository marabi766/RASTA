-- Reverses 20260926120000_transaction_state_actors.
--
-- Drops the recorded actors of authorise-settlement, cancel and refund. The
-- TRANSACTION_STATUS_CHANGED events already published keep that history in
-- the audit trail; the columns are the row's own copy of it.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction"
  DROP COLUMN IF EXISTS "settlement_authorised_at",
  DROP COLUMN IF EXISTS "settlement_authorised_by",
  DROP COLUMN IF EXISTS "cancelled_at",
  DROP COLUMN IF EXISTS "cancelled_by",
  DROP COLUMN IF EXISTS "refunded_at",
  DROP COLUMN IF EXISTS "refunded_by";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926120000_transaction_state_actors';
