-- =============================================================================
-- Reverse of `migration.sql` (20261001100000_payment_reconciliation_resolution).
--
-- Refuses while ANY resolution or requeue row exists — pending or decided
-- (Codex on #175, HIGH 2). Those rows are the only record of the evidence, the
-- outcome, the reasons and whether four-eyes applied; audit-service holds the
-- events, not them. Dropping the tables would destroy that history, so a
-- rollback is possible only on a database that never used the operator path.
--
-- One transaction, the table locks first (as in 20260930200000): a row being
-- written is either counted, so the rollback refuses, or waits and then fails.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE resolution_count BIGINT := 0;
DECLARE requeue_count BIGINT := 0;
BEGIN
  IF to_regclass('payment_reconciliation_resolution') IS NOT NULL THEN
    LOCK TABLE payment_reconciliation_resolution IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO resolution_count FROM payment_reconciliation_resolution;
  END IF;
  IF to_regclass('payment_reconciliation_requeue') IS NOT NULL THEN
    LOCK TABLE payment_reconciliation_requeue IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO requeue_count FROM payment_reconciliation_requeue;
  END IF;
  IF resolution_count > 0 OR requeue_count > 0 THEN
    RAISE EXCEPTION 'the operator path holds % resolution(s) and % requeue(s); refusing to drop its history',
      resolution_count, requeue_count
      USING HINT = 'They are the only record of the evidence and the reasons (docs/runbooks/payment-refund-stuck.md).';
  END IF;
END
$$;

DROP TABLE IF EXISTS "payment_reconciliation_requeue";
DROP FUNCTION IF EXISTS reject_payment_requeue_mutation();
DROP TABLE IF EXISTS "payment_reconciliation_resolution";
DROP FUNCTION IF EXISTS guard_payment_resolution_history();
DROP TYPE IF EXISTS "PaymentResolutionOutcome";
DROP TYPE IF EXISTS "PaymentResolutionStatus";
DROP INDEX IF EXISTS "payment_reconciliation_task_organization_id_id_key";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001100000_payment_reconciliation_resolution';

COMMIT;
