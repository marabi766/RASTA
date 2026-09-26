-- Who moved a transaction, and when (economic batch 2, item b; AGENTS.md S-06).
--
-- Dispute and dispute resolution already recorded their actor. Confirming
-- receipt (authorise-settlement), cancelling and refunding recorded nobody:
-- the row said only that the status had changed. Each of those steps now
-- writes its actor and instant here, and every lifecycle step writes a
-- TRANSACTION_STATUS_CHANGED outbox row in the same transaction.
--
-- Populated databases: nullable columns with no default and no constraint,
-- so every existing row stays valid and the ALTER is a catalogue change only.
-- Rows moved before this migration keep NULL: who did it was never recorded,
-- and inventing an actor for them would be worse than saying so.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction"
  ADD COLUMN IF NOT EXISTS "settlement_authorised_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "settlement_authorised_by" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelled_by" TEXT,
  ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refunded_by" TEXT;
