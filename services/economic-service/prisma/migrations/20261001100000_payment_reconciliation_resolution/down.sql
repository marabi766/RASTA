-- =============================================================================
-- Reverse of `migration.sql` (20261001100000_payment_reconciliation_resolution).
--
-- Refuses while any proposal awaits approval: dropping the table would drop a
-- person's proposal and leave its refund held with nobody told. Approve or
-- reject them first. Decided rows are history and go with the table; the money
-- they moved is in the ledger, and their events are in audit-service.
--
-- One transaction, the table lock first (as in 20260930200000): a proposal in
-- flight is either counted, so the rollback refuses, or waits and then fails.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE pending_count BIGINT;
BEGIN
  IF to_regclass('payment_reconciliation_resolution') IS NOT NULL THEN
    LOCK TABLE payment_reconciliation_resolution IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO pending_count FROM payment_reconciliation_resolution
     WHERE status = 'PENDING_APPROVAL';
    IF pending_count > 0 THEN
      RAISE EXCEPTION 'payment_reconciliation_resolution has % pending proposal(s); refusing to drop it', pending_count
        USING HINT = 'Approve or reject them first (docs/runbooks/payment-refund-stuck.md).';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS "payment_reconciliation_resolution";
DROP TYPE IF EXISTS "PaymentResolutionOutcome";
DROP TYPE IF EXISTS "PaymentResolutionStatus";
DROP INDEX IF EXISTS "payment_reconciliation_task_organization_id_id_key";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001100000_payment_reconciliation_resolution';

COMMIT;
