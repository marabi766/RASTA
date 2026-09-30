-- =============================================================================
-- Reverse of `migration.sql` (20260930200000_payment_reconciliation_task).
--
-- Refuses while any task is open. An open task is a refund whose outcome is
-- not recorded, with its amount held: dropping the queue would leave the
-- marker on the intent and nothing that ever looks at it again — the state B1
-- exists to end. Finish or escalate-and-resolve those refunds first
-- (docs/runbooks/payment-refund-stuck.md), then roll back. DONE tasks are
-- history and are dropped with the table; the intents keep their own record.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE open_count BIGINT;
BEGIN
  IF to_regclass('payment_reconciliation_task') IS NOT NULL THEN
    SELECT count(*) INTO open_count FROM payment_reconciliation_task WHERE status <> 'DONE';
    IF open_count > 0 THEN
      RAISE EXCEPTION 'payment_reconciliation_task has % open task(s); refusing to drop the queue', open_count
        USING HINT = 'Resolve the unfinished refunds first (docs/runbooks/payment-refund-stuck.md).';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS "payment_reconciliation_task";
DROP TYPE IF EXISTS "PaymentReconciliationStatus";
DROP TYPE IF EXISTS "PaymentReconciliationKind";
DROP INDEX IF EXISTS "payment_intent_organization_id_id_key";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930200000_payment_reconciliation_task';
