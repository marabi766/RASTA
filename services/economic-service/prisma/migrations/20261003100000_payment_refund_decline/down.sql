-- =============================================================================
-- Reverse of `migration.sql` (20261003100000_payment_refund_decline).
--
-- The rows are a de-duplication record, not evidence: every decline they name
-- was announced, and the events are in the outbox and in audit-service. The
-- code that writes them goes with the rollback, so the table is dropped with
-- whatever it holds. Re-applied, it starts empty — a decline replayed after
-- that could be announced once more, which is the state before this migration.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "payment_refund_decline";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261003100000_payment_refund_decline';

COMMIT;
