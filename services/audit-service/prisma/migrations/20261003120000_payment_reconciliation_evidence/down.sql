-- =============================================================================
-- Reverse of `migration.sql` (the payment-reconciliation evidence projection).
--
-- **Refused while any projected row exists.** These rows are audit-service's only
-- copy of who proposed, who approved and on which evidence (D-046): they cannot be
-- rebuilt by replay once `rasta.economic.v1`'s retention has passed. Locks the table
-- first, then counts; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "payment_reconciliation_evidence" IN ACCESS EXCLUSIVE MODE;

DO $preflight_reconciliation_evidence$
DECLARE
  projected bigint;
BEGIN
  SELECT count(*) INTO projected FROM "payment_reconciliation_evidence";
  IF projected > 0 THEN
    RAISE EXCEPTION 'down refused: % payment reconciliation evidence row(s) exist. They are the audit record of who proposed and approved a resolution on which evidence, and cannot be rebuilt from the topic after its retention. Keep this migration, or archive them and decide by hand.', projected
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_reconciliation_evidence$;

DROP TRIGGER IF EXISTS "tg_payment_reconciliation_evidence_append_only" ON "payment_reconciliation_evidence";
DROP TRIGGER IF EXISTS "tg_payment_reconciliation_evidence_no_truncate" ON "payment_reconciliation_evidence";
DROP FUNCTION IF EXISTS "payment_reconciliation_evidence_append_only"();

DROP TABLE IF EXISTS "payment_reconciliation_evidence";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261003120000_payment_reconciliation_evidence';

COMMIT;
