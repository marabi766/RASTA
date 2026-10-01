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
--
-- One explicit transaction, and the table lock comes FIRST (Codex on #161,
-- HIGH 2). Counting and then dropping was a race: a refund could open a task
-- after the count and before the DROP, and the DROP took it. ACCESS EXCLUSIVE
-- before the count means an insert either committed before it (and is
-- counted, so the rollback refuses) or waits behind it and then fails on the
-- dropped table, its whole refund transaction — hold and marker included —
-- rolling back with it. `lock_timeout` bounds the wait on live traffic: the
-- rollback then fails safe and changes nothing.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE open_count BIGINT;
BEGIN
  IF to_regclass('payment_reconciliation_task') IS NOT NULL THEN
    LOCK TABLE payment_reconciliation_task IN ACCESS EXCLUSIVE MODE;
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

COMMIT;
